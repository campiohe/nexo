#pragma once
// Where encoded video goes. The LiveKit implementation (publish/livekit.cpp) is the only code that includes the
// SDK, so SDK upgrades stay contained (SPEC-BETA §4.8). The null publisher discards frames: it lets the whole
// pipeline run without a LiveKit server (dry runs, NEXO_WITH_LIVEKIT=OFF builds).

#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <span>
#include <string>

#include "ipc/protocol.hpp"
#include "video/encoder_mf.hpp"

namespace nexo {

struct PublishFeedback {
  bool keyframeRequested = false;
  std::optional<uint64_t> targetBitrateBps;
  std::optional<double> framerateFps;
};

struct VideoTrackConfig {
  uint32_t width = 0;
  uint32_t height = 0;
  double fps = 60;
  uint64_t maxBitrate = 0;
  ipc::ContentHint hint = ipc::ContentHint::Motion;
};

struct PublisherCallbacks {
  /// reconnecting / live after a reconnect (SDK threads).
  std::function<void(ipc::State)> onState;
  /// The room is gone for good (kicked, server shut down, reconnect gave up). SDK threads.
  std::function<void(const std::string& reason)> onDisconnected;
};

class Publisher {
 public:
  virtual ~Publisher() = default;
  /// Blocking. Throws ShareError(livekit-connect).
  virtual void connect(const std::string& url, const std::string& token) = 0;
  /// Publishes the pre-encoded H.264 track as ScreenShare "screen". Throws ShareError(livekit-connect).
  virtual void publishVideo(const VideoTrackConfig& config) = 0;
  /// One access unit. Called from one thread at a time (the encoder's output callback). False = rejected.
  virtual bool sendVideo(EncodedFrame&& frame) = 0;
  /// Keyframe requests and rate-control targets accumulated since the last call (any thread).
  virtual PublishFeedback takeFeedback() = 0;
  /// Publishes the stream audio track: ScreenShareAudio "screen-audio", 48 kHz stereo (SPEC-BETA §4.7).
  /// Call after connect(). Throws ShareError(audio-failed).
  virtual void publishAudio() = 0;
  /// One 10 ms frame, interleaved int16, 48 kHz stereo. Called from the audio thread only. False = rejected.
  virtual bool sendAudio(std::span<const int16_t> frame) = 0;
  /// Unpublish + disconnect. Idempotent, blocking.
  virtual void close() = 0;
  /// Stops calling the callbacks (blocks until a callback in progress returns). For a share that is going
  /// away while this publisher lives on (an abandoned connect).
  virtual void detachCallbacks() = 0;
  virtual std::string describe() const = 0;
};

std::unique_ptr<Publisher> createNullPublisher(PublisherCallbacks callbacks);

#if defined(NEXO_WITH_LIVEKIT)
std::unique_ptr<Publisher> createLiveKitPublisher(PublisherCallbacks callbacks);
/// livekit::shutdown() if the SDK was initialized. Call once at process exit.
void shutdownLiveKit();
#endif

} // namespace nexo
