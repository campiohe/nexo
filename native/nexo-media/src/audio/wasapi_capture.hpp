#pragma once
// WASAPI capture, configured here for process loopback (SPEC-BETA §4.7): only one app's audio (INCLUDE its
// process tree) or everything except Nexo (EXCLUDE Electron main's tree). 48 kHz stereo int16, delivered as
// 10 ms frames on the capture thread, with silence filled in while the source is quiet (audio_framer.hpp).
//
// One generic class: the activation target is the only process-loopback-specific part, so endpoint capture
// can reuse it later.

#include <windows.h>
// Before any C++/WinRT header: the .cpp implements a classic COM interface with winrt::implements.
#include <unknwn.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <span>
#include <string>
#include <thread>

#include <winrt/base.h>

struct IAudioClient;
struct IAudioCaptureClient;

namespace nexo {

enum class LoopbackMode { IncludeProcessTree, ExcludeProcessTree };

struct AudioCaptureConfig {
  LoopbackMode mode = LoopbackMode::ExcludeProcessTree;
  uint32_t pid = 0;
};

class WasapiCapture {
 public:
  static constexpr uint32_t kSampleRate = 48'000;
  static constexpr uint32_t kChannels = 2;
  static constexpr uint32_t kFrameSamples = kSampleRate / 100; ///< per channel, 10 ms

  /// One 10 ms frame, interleaved (kChannels × kFrameSamples). Capture thread.
  using FrameFn = std::function<void(std::span<const int16_t> frame)>;
  /// The capture stopped for good. Capture thread, at most once.
  using ErrorFn = std::function<void(const std::string& message)>;

  explicit WasapiCapture(AudioCaptureConfig config);
  ~WasapiCapture();
  WasapiCapture(const WasapiCapture&) = delete;
  WasapiCapture& operator=(const WasapiCapture&) = delete;

  /// Activates the process-loopback client and initializes it for 48 kHz stereo int16 (blocking, bounded).
  /// Throws ShareError(audio-failed).
  void open();
  /// Starts the capture thread. Call after open().
  void start(FrameFn onFrame, ErrorFn onError);
  /// Stops and joins the capture thread. Idempotent.
  void stop();

  uint64_t capturedFrames() const { return captured_.load(); }
  uint64_t silenceFrames() const { return silence_.load(); }
  uint64_t discontinuities() const { return discontinuities_.load(); }
  std::string describe() const;

  /// The OS can do process loopback. Microsoft's docs say "build 20348", but the API is present from Windows 10
  /// 2004 (19041): OBS's Application Audio Capture uses it there. So 19041+ is advertised, and a build where
  /// activation still fails reports audio-failed at share time (the video keeps going).
  static bool supported(uint32_t osBuild) { return osBuild >= 19041; }

 private:
  void run(FrameFn onFrame, ErrorFn onError);

  AudioCaptureConfig config_;
  winrt::com_ptr<IAudioClient> client_;
  winrt::com_ptr<IAudioCaptureClient> capture_;
  winrt::handle sampleEvent_;
  winrt::handle stopEvent_;
  std::thread thread_;
  std::atomic<uint64_t> captured_{0};
  std::atomic<uint64_t> silence_{0};
  std::atomic<uint64_t> discontinuities_{0};
};

} // namespace nexo
