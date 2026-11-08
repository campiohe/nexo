#pragma once
// One share: source → FrameRing → VideoConverter → MfEncoder → Publisher, plus the encode thread that paces it,
// the stream audio and the 1 Hz stats (SPEC-BETA §4.2). Emits state / stats / error / ended events itself.
//
// Under a GPU-bound foreground game each job we put on the 3D queue waits tens of ms (beta-m3-fps-gap.md), so by
// default the ring keeps WGC's own buffers (no copy) and the encoder only ever gets a frame whose conversion the
// GPU has already finished, with several conversions in flight: the waits overlap instead of adding up.
//
// Lifecycle (protocol rules agreed with the Electron supervisor):
//   prepare()  synchronous, validates and builds everything local (device, capture item, encoder). Throws
//              ShareError → the `start` result fails and nothing else is emitted for this share.
//   start()    after the ok result: connecting → (connect, publish) → live, then the encode loop.
//   …          ends exactly once with `state: stopped` then `ended {reason}`.
//
// The LiveKit connect runs on its own thread so a `stop` during it answers at once: the share ends and the
// connect is abandoned (it disconnects by itself when it returns). One LiveKit session exists at a time per
// process, so a new share waits for an abandoned connect to finish instead of colliding with it (§4.8).

#include <windows.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <optional>
#include <thread>

#include "audio/wasapi_capture.hpp"
#include "audio/wav_writer.hpp"
#include "capture/frame_ring.hpp"
#include "capture/frame_source.hpp"
#include "d3d/device.hpp"
#include "ipc/protocol.hpp"
#include "publish/publisher.hpp"
#include "share/device_loss.hpp"
#include "video/convert.hpp"
#include "video/encoder_mf.hpp"
#include "video/pacer.hpp"

namespace nexo {

/// Pipelined conversion (docs/benchmarks/beta-m3-fps-gap.md): a converted frame goes to the encoder only once
/// the GPU has finished the conversion, with up to Share::kMaxConverted in flight. NEXO_MEDIA_PIPELINE=0|1.
inline constexpr bool kPipelineDefault = true;

struct ShareSpec {
  enum class Kind { Window, Monitor, TestPattern };
  Kind kind = Kind::Monitor;
  HWND hwnd = nullptr;
  ipc::Rect monitorRect;
  Size patternSize{1920, 1080};
  ipc::Preset preset;
  bool cursor = true;
  /// Stream audio (SPEC-BETA §4.7). `app` on a monitor is treated as `system-but-nexo` (see resolveAudio).
  ipc::AudioMode audio = ipc::AudioMode::Off;
  /// system-but-nexo: Electron main's PID, whose process tree is left out of the capture.
  uint32_t excludePid = 0;
  /// app on a source without a window (CLI test pattern): the process whose tree is captured.
  uint32_t audioPid = 0;
  std::optional<std::filesystem::path> dumpWav;
  /// nullopt = dry run: everything runs, encoded frames are discarded.
  std::optional<ipc::LiveKitCredentials> livekit;
  std::optional<std::filesystem::path> dumpH264;
};

/// Waits until no LiveKit session (including an abandoned connect) is alive, so livekit::shutdown() at exit
/// doesn't pull the FFI runtime from under a pending connect. False on timeout.
bool waitLiveKitIdle(std::chrono::milliseconds timeout);

class Share {
  struct Private {
    explicit Private() = default;
  };

 public:
  static std::unique_ptr<Share> prepare(const ShareSpec& spec);
  explicit Share(Private) {}
  ~Share();
  Share(const Share&) = delete;
  Share& operator=(const Share&) = delete;

  void start();
  /// Live preset/cursor change. Throws ShareError(protocol) for a size change (needs stop + start).
  void update(const std::optional<ipc::PresetPatch>& preset, std::optional<bool> cursor);
  /// Asks the share to end with reason `stopped` (no-op if it already ended). Non-blocking.
  void requestStop();
  /// Waits for the share thread to finish; false on timeout.
  bool waitFinished(std::chrono::milliseconds timeout);
  bool finished() const { return finished_.load(); }
  /// The reason it ended (valid once finished()).
  ipc::EndReason endReason() const;

 private:
  enum class Recovery { Recovered, Ended };

  void run();
  /// Connects on a separate thread. False when the share was stopped first (the connect is abandoned).
  bool connectPublisher();
  void encodeLoop();
  /// Device, ring, source, converter and encoder. `initial` also picks the output size and the pacer.
  void buildPipeline(bool initial);
  void teardownPipeline();
  std::unique_ptr<MfEncoder> createEncoder(const EncoderRates& rates, double fps);
  /// RGB-input encoder and a frame that is exactly the output: it can go to the MFT as is.
  bool canEncodeDirectly(const FrameRing::Frame& frame) const;
  /// A new encoder on the same device: for changes the MFT can't take mid-stream (rate-control mode, fps).
  void rebuildEncoder(const char* why);
  /// SPEC-BETA §4.3: rebuild everything but the publisher, keeping the track published.
  Recovery recoverDevice(HRESULT reason);
  bool deviceLost() const;
  void teardown();
  void endWith(ipc::EndReason reason);
  bool ending() const;
  void fail(ipc::ErrorCode code, const std::string& message, ipc::EndReason reason = ipc::EndReason::Error);
  void onEncoded(EncodedFrame&& frame);
  void startAudio();
  void audioFailed(const std::string& message);
  void handleFeedback(int64_t nowUs);
  void emitStats(int64_t nowUs);

  ShareSpec spec_;
  std::shared_ptr<D3DDevice> device_;
  bool pipelined() const { return static_cast<bool>(convertFence_); }

  std::shared_ptr<FrameRing> ring_; ///< shared: encoder input samples give their frame back through a weak_ptr
  std::unique_ptr<FrameSource> source_;
  std::unique_ptr<VideoConverter> converter_;
  std::unique_ptr<MfEncoder> encoder_;

  // Pipelined conversion (encode thread only).
  static constexpr size_t kMaxConverted = 6;
  struct Converted {
    MfEncoder::Input input;
    int64_t ts = 0;
    bool keyframe = false;
    uint64_t fence = 0;
    int64_t convertedUs = 0;
  };
  std::deque<Converted> converted_;
  winrt::com_ptr<ID3D11DeviceContext4> convertContext_;
  winrt::com_ptr<ID3D11Fence> convertFence_;
  uint64_t convertFenceValue_ = 0;
  winrt::handle convertEvent_;
  /// shared: an abandoned connect keeps it alive (and closes it) after this share is gone.
  std::shared_ptr<Publisher> publisher_;
  std::shared_ptr<void> liveKitTicket_; ///< holds the process-wide LiveKit gate while this share uses it
  Size output_;
  bool converterDetail_ = false; ///< encode thread: the hint the converter is set up for
  std::atomic<int> pendingCursor_{-1}; ///< update() → encode thread: -1 none, 0 off, 1 on

  std::optional<AudioCaptureConfig> audioConfig_;
  std::unique_ptr<WasapiCapture> audio_;
  std::atomic<bool> audioFailed_{false};
  std::unique_ptr<WavWriter> wav_; ///< audio thread only (after start), then teardown

  std::mutex pacerMutex_; ///< pacer + spec_.preset (update() runs on the control thread)
  std::unique_ptr<Pacer> pacer_;

  DeviceLossPolicy lossPolicy_;
  int64_t testDeviceLostAfterUs_ = 0; ///< NEXO_MEDIA_TEST_DEVICE_LOST_AFTER_MS
  int testRebuildFailures_ = 0;       ///< NEXO_MEDIA_TEST_DEVICE_REBUILD_FAILS

  winrt::handle stopEvent_;
  mutable std::mutex endMutex_;
  std::optional<ipc::EndReason> endReason_;
  std::atomic<bool> finished_{false};
  std::thread thread_;
  std::mutex finishedMutex_;
  std::condition_variable finishedCv_;

  std::ofstream dump_;
  std::mutex dumpMutex_;

  // Stats. Counters of the current encoder/ring restart at 0 after a device rebuild; the bases carry the
  // totals across it.
  uint64_t dropped_ = 0;
  uint64_t busy_ = 0;
  uint64_t poolEmpty_ = 0;
  uint64_t profBusy_ = 0;      ///< NEXO_MEDIA_PROFILE: counters at the last profile line
  uint64_t profPoolEmpty_ = 0;
  uint64_t keyframesBase_ = 0;
  std::atomic<uint64_t> rejected_{0};
  std::atomic<uint64_t> keyframeRequests_{0};
  int64_t statsAtUs_ = 0;
  int64_t lastStatsUs_ = 0;
  uint64_t lastPushed_ = 0;
  uint64_t lastOutFrames_ = 0;
  uint64_t lastOutBytes_ = 0;
  uint64_t lastLoggedTarget_ = 0;
  double lastFps_ = 0;
  std::optional<RateMode> lastMode_;
};

} // namespace nexo
