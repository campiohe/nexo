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
};

} // namespace nexo
