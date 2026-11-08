#pragma once
// Windows.Graphics.Capture through C++/WinRT (SPEC-BETA §4.4).

#include <d3d11.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>

#include <atomic>
#include <memory>
#include <mutex>

#include "capture/frame_ring.hpp"
#include "capture/frame_source.hpp"
#include "d3d/device.hpp"

namespace nexo {

/// What this OS build supports, checked with ApiInformation so older builds degrade quietly.
struct WgcFeatures {
  bool supported = false;         ///< GraphicsCaptureSession::IsSupported()
  bool cursorToggle = false;      ///< IsCursorCaptureEnabled (Win10 2004)
  bool borderless = false;        ///< IsBorderRequired (Win11)
  bool minUpdateInterval = false; ///< MinUpdateInterval (Win11 24H2)
  bool secondaryWindows = false;  ///< IncludeSecondaryWindows (Win11 24H2)
};
WgcFeatures queryWgcFeatures();

/// Zero copy (docs/benchmarks/beta-m3-fps-gap.md): the ring keeps WGC's own buffers instead of copying them.
/// NEXO_MEDIA_ZERO_COPY=0|1 overrides the default.
inline constexpr bool kZeroCopyDefault = true;
bool zeroCopyEnabled();

class WgcCapture final : public FrameSource {
 public:
  struct Target {
    HWND hwnd = nullptr;
    HMONITOR monitor = nullptr;
  };

  /// Creates the capture item. Throws ShareError(capture-failed) when the target can't be captured.
  WgcCapture(std::shared_ptr<D3DDevice> device, FrameRing& ring, Target target, bool cursor, double fps);
  ~WgcCapture() override;

  Size initialSize() const override;
  void start() override;
  void stop() override;
  bool stalled(int64_t nowUs) const override;
  bool closed() const override { return closed_.load(); }
  void setCursor(bool enabled) override;
  void setFrameRate(double fps) override;
  std::string describe() const override;

 private:
  void onFrameArrived(const winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool& pool);
  void applyMinUpdateInterval(double fps);
  void resizeIfNeeded(const winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool& pool,
                      winrt::Windows::Graphics::SizeInt32 content);

  std::shared_ptr<D3DDevice> device_;
  FrameRing& ring_;
  Target target_;
  bool cursor_;
  double fps_;
  WgcFeatures features_;
  winrt::Windows::Graphics::Capture::GraphicsCaptureItem item_{nullptr};
  winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool pool_{nullptr};
  winrt::Windows::Graphics::Capture::GraphicsCaptureSession session_{nullptr};
  winrt::event_token frameArrivedToken_{};
  winrt::event_token closedToken_{};
  winrt::Windows::Graphics::SizeInt32 poolSize_{};

  std::mutex mutex_; ///< serializes the frame callback against stop() and pool recreation
  bool stopped_ = false;
  bool started_ = false;
  std::atomic<bool> closed_{false};
  std::atomic<uint64_t> recreates_{0};

  // Experiment levers (docs/benchmarks/beta-m3-fps-gap.md), read once at construction.
  int32_t poolBuffers_ = 2;        ///< NEXO_MEDIA_WGC_BUFFERS
  double minIntervalMs_ = -1;      ///< NEXO_MEDIA_WGC_MIN_INTERVAL_MS (-1: 1 / fps, 0: not set)
  bool rawCount_ = false;          ///< NEXO_MEDIA_PROFILE_RAW: count frames, process nothing
  bool zeroCopy_ = true;           ///< NEXO_MEDIA_ZERO_COPY: keep the WGC buffer instead of copying it
  int64_t lastArrivalUs_ = 0;      ///< profiling (callback thread, under mutex_)
};

} // namespace nexo
