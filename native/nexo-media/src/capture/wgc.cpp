#include "capture/wgc.hpp"

#include <Windows.Graphics.Capture.Interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/Windows.Security.Authorization.AppCapabilityAccess.h>

#include <algorithm>
#include <chrono>
#include <format>

#include "common/log.hpp"
#include "common/profile.hpp"
#include "common/win_error.hpp"

namespace nexo {

namespace wgc = winrt::Windows::Graphics::Capture;
using winrt::Windows::Foundation::Metadata::ApiInformation;

namespace {

constexpr auto kPixelFormat = winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized;
// Copy mode: two buffers, one being copied by us, one being filled by DWM. We return each right after the copy.
constexpr int32_t kPoolBuffers = 2;
// Zero copy: the ring keeps the latest frame, the encoder can hold a few (RGB input: until it has read them),
// and DWM needs at least one free to write the next frame into.
constexpr int32_t kZeroCopyPoolBuffers = 6;

double envDouble(const char* name, double fallback) {
  const auto v = envString(name);
  if (v.empty()) return fallback;
  try {
    return std::stod(v);
  } catch (...) {
    return fallback;
  }
}

bool sessionProperty(const wchar_t* name) {
  try {
    return ApiInformation::IsPropertyPresent(L"Windows.Graphics.Capture.GraphicsCaptureSession", name);
  } catch (...) {
    return false;
  }
}

/// Borderless capture needs GraphicsCaptureAccess to say Allowed. ApiInformation only tells us the property
/// exists; an unpackaged exe can be refused (NotDeclaredByApp / ERROR_NOT_FOUND), so ask once and remember.
bool borderlessAllowed() {
  static const bool allowed = [] {
    if (!sessionProperty(L"IsBorderRequired")) return false;
    try {
      const auto status = wgc::GraphicsCaptureAccess::RequestAccessAsync(wgc::GraphicsCaptureAccessKind::Borderless).get();
      using winrt::Windows::Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus;
      if (status != AppCapabilityAccessStatus::Allowed) {
        log::debug("capture: borderless access status {} (4 = allowed)", static_cast<int>(status));
      }
      return status == AppCapabilityAccessStatus::Allowed;
    } catch (const winrt::hresult_error& e) {
      log::debug("capture: borderless access request failed: {}", describeHresult(e.code()));
      return false;
    }
  }();
  return allowed;
}

} // namespace

WgcFeatures queryWgcFeatures() {
  WgcFeatures f;
  try {
    f.supported = wgc::GraphicsCaptureSession::IsSupported();
  } catch (...) {
    f.supported = false;
  }
  f.cursorToggle = sessionProperty(L"IsCursorCaptureEnabled");
  f.borderless = borderlessAllowed();
  f.minUpdateInterval = sessionProperty(L"MinUpdateInterval");
  f.secondaryWindows = sessionProperty(L"IncludeSecondaryWindows");
  return f;
}

WgcCapture::WgcCapture(std::shared_ptr<D3DDevice> device, FrameRing& ring, Target target, bool cursor, double fps)
    : device_(std::move(device)), ring_(ring), target_(target), cursor_(cursor), fps_(fps), features_(queryWgcFeatures()) {
  zeroCopy_ = zeroCopyEnabled();
  poolBuffers_ = static_cast<int32_t>(std::clamp(envDouble("NEXO_MEDIA_WGC_BUFFERS", zeroCopy_ ? kZeroCopyPoolBuffers : kPoolBuffers), 1.0, 8.0));
  minIntervalMs_ = envDouble("NEXO_MEDIA_WGC_MIN_INTERVAL_MS", -1);
  rawCount_ = envFlag("NEXO_MEDIA_PROFILE_RAW");
  if (!features_.supported) throw ShareError(ipc::ErrorCode::CaptureFailed, "Windows.Graphics.Capture is not supported on this system");
  auto interop = winrt::get_activation_factory<wgc::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
  HRESULT hr = E_INVALIDARG;
  if (target_.hwnd) {
    if (!IsWindow(target_.hwnd)) throw ShareError(ipc::ErrorCode::CaptureFailed, "the window no longer exists");
    hr = interop->CreateForWindow(target_.hwnd, winrt::guid_of<wgc::GraphicsCaptureItem>(), winrt::put_abi(item_));
  } else if (target_.monitor) {
    hr = interop->CreateForMonitor(target_.monitor, winrt::guid_of<wgc::GraphicsCaptureItem>(), winrt::put_abi(item_));
  }
  if (FAILED(hr) || !item_) {
    throw ShareError(ipc::ErrorCode::CaptureFailed, "cannot capture " + describe() + ": " + describeHresult(hr));
  }
  closedToken_ = item_.Closed([this](auto&&, auto&&) {
    // Window closed (or monitor unplugged): the encode loop sees closed() and ends the share (source-closed).
    closed_.store(true);
  });
}

WgcCapture::~WgcCapture() {
  stop();
  if (item_) item_.Closed(closedToken_);
}

Size WgcCapture::initialSize() const {
  const auto s = item_.Size();
  return {static_cast<uint32_t>(std::max(0, s.Width)), static_cast<uint32_t>(std::max(0, s.Height))};
}

std::string WgcCapture::describe() const {
  if (target_.hwnd) return std::format("window 0x{:X}", reinterpret_cast<uintptr_t>(target_.hwnd));
  return std::format("monitor 0x{:X}", reinterpret_cast<uintptr_t>(target_.monitor));
}

void WgcCapture::start() {
  std::lock_guard lock(mutex_);
  if (started_ || stopped_) return;
  started_ = true;

  poolSize_ = item_.Size();
  // Free-threaded: FrameArrived runs on a system thread-pool thread, so no DispatcherQueue is needed and a
  // busy control thread can't delay frames.
  pool_ = wgc::Direct3D11CaptureFramePool::CreateFreeThreaded(device_->winrtDevice(), kPixelFormat, poolBuffers_, poolSize_);
  frameArrivedToken_ = pool_.FrameArrived([this](const wgc::Direct3D11CaptureFramePool& pool, auto&&) { onFrameArrived(pool); });
  session_ = pool_.CreateCaptureSession(item_);

  if (features_.cursorToggle) session_.IsCursorCaptureEnabled(cursor_);
  bool borderOff = false;
  if (features_.borderless) {
    try {
      session_.IsBorderRequired(false);
      borderOff = !session_.IsBorderRequired();
    } catch (const winrt::hresult_error& e) {
      log::info("capture: the yellow border stays (IsBorderRequired: {})", describeHresult(e.code()));
    }
  }
  if (target_.hwnd && features_.secondaryWindows) {
    // Menus, tooltips and dialogs of the shared app show up in the stream like they do on screen.
    session_.IncludeSecondaryWindows(true);
  }
  applyMinUpdateInterval(fps_);
  session_.StartCapture();
  log::info("capture: started {} ({}x{}, cursor {}, border {}, minUpdateInterval {}, {} buffers{}{})", describe(),
            poolSize_.Width, poolSize_.Height, cursor_ ? "on" : "off", borderOff ? "off" : "required",
            !features_.minUpdateInterval ? "unsupported" : minIntervalMs_ == 0 ? "off" : "set", poolBuffers_,
            zeroCopy_ ? ", zero copy" : "", rawCount_ ? ", RAW COUNT ONLY (profiling)" : "");
}

void WgcCapture::applyMinUpdateInterval(double fps) {
  if (!session_ || !features_.minUpdateInterval || fps <= 0 || minIntervalMs_ == 0) return;
  // Caps DWM's delivery at the preset rate (24H2+): fewer copies when the game renders far above it.
  const double seconds = minIntervalMs_ > 0 ? minIntervalMs_ / 1000.0 : 1.0 / fps;
  const auto interval = std::chrono::duration_cast<winrt::Windows::Foundation::TimeSpan>(std::chrono::duration<double>(seconds));
  try {
    session_.MinUpdateInterval(interval);
  } catch (const winrt::hresult_error& e) {
    log::warn("capture: MinUpdateInterval failed: {}", describeHresult(e.code()));
  }
}

void WgcCapture::stop() {
  {
    // Waits for an in-flight callback (it holds the mutex), after which no callback does any work.
    std::lock_guard lock(mutex_);
    if (stopped_) return;
    stopped_ = true;
  }
  if (pool_) pool_.FrameArrived(frameArrivedToken_);
  if (session_) session_.Close();
  if (pool_) pool_.Close();
  session_ = nullptr;
  pool_ = nullptr;
  if (started_) log::info("capture: stopped {} ({} pool recreations)", describe(), recreates_.load());
}

void WgcCapture::onFrameArrived(const wgc::Direct3D11CaptureFramePool& pool) {
  const int64_t enteredUs = profile::enabled() ? qpcMicros() : 0;
  std::lock_guard lock(mutex_);
  if (stopped_) return;
  try {
    auto frame = pool.TryGetNextFrame();
    if (!frame) return;
    if (profile::enabled()) {
      if (lastArrivalUs_) profile::record(profile::Stage::WgcArrive, enteredUs - lastArrivalUs_);
      lastArrivalUs_ = enteredUs;
      profile::record(profile::Stage::WgcDelay, enteredUs - frame.SystemRelativeTime().count() / 10);
      if (rawCount_) {
        // Upper bound: what WGC delivers when we do no GPU work at all.
        frame.Close();
        return;
      }
    }
    if (target_.hwnd && IsIconic(target_.hwnd)) {
      // Minimizing delivers one last frame of the title-bar stub (~150x23). Streaming it would replace the
      // picture with a letterboxed sliver; viewers keep the last real frame instead (stats say "stalled").
      frame.Close();
      return;
    }
    const auto content = frame.ContentSize();
    {
      auto access = frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
      winrt::com_ptr<ID3D11Texture2D> texture;
      check(access->GetInterface(IID_PPV_ARGS(texture.put())), "IDirect3DDxgiInterfaceAccess::GetInterface");
      // SystemRelativeTime is QPC-based, in 100 ns units.
      const int64_t timestampUs = frame.SystemRelativeTime().count() / 10;
      const Size contentSize{static_cast<uint32_t>(std::max(0, content.Width)), static_cast<uint32_t>(std::max(0, content.Height))};
      if (zeroCopy_) {
        // No GPU work here at all: the encode thread reads DWM's buffer and the ring gives it back once it is
        // superseded and no longer used (a copy queues behind a foreground game for ~50 ms, see
        // docs/benchmarks/beta-m3-fps-gap.md).
        if (ring_.pushHeld(texture, contentSize, timestampUs, [frame]() { frame.Close(); })) {
          if (enteredUs) profile::record(profile::Stage::WgcCallback, qpcMicros() - enteredUs);
          resizeIfNeeded(pool, content);
          return;
        }
        profile::count("ringFull");
        frame.Close();
        return;
      }
      auto& probe = device_->probe();
      const auto scope = probe.begin();
      ring_.push(device_->context(), texture.get(),
                 {static_cast<uint32_t>(std::max(0, content.Width)), static_cast<uint32_t>(std::max(0, content.Height))},
                 timestampUs);
      probe.end(scope, profile::Stage::CopyGpu, profile::Stage::CopyDone);
    }
    frame.Close(); // give the buffer back to DWM right away
    if (enteredUs) profile::record(profile::Stage::WgcCallback, qpcMicros() - enteredUs);

    resizeIfNeeded(pool, content);
  } catch (const winrt::hresult_error& e) {
    log::warn("capture: frame failed: {}", describeHresult(e.code()));
  } catch (const std::exception& e) {
    log::warn("capture: frame failed: {}", e.what());
  }
}

void WgcCapture::resizeIfNeeded(const wgc::Direct3D11CaptureFramePool& pool, winrt::Windows::Graphics::SizeInt32 content) {
  if (content.Width > 0 && content.Height > 0 && (content.Width != poolSize_.Width || content.Height != poolSize_.Height)) {
    // The source was resized. The output size stays fixed (the converter letterboxes, §4.4); only the pool
    // buffers follow the content. Frames still held (zero copy) stay valid until they are closed.
    poolSize_ = content;
    pool.Recreate(device_->winrtDevice(), kPixelFormat, poolBuffers_, poolSize_);
    recreates_.fetch_add(1);
    log::info("capture: source resized to {}x{}", content.Width, content.Height);
  }
}

bool zeroCopyEnabled() {
  const auto v = envString("NEXO_MEDIA_ZERO_COPY");
  return v.empty() ? kZeroCopyDefault : envFlag("NEXO_MEDIA_ZERO_COPY");
}

bool WgcCapture::stalled(int64_t nowUs) const {
  // Only windows stall: WGC stops delivering for a minimized window. A static monitor isn't "stalled".
  if (!target_.hwnd) return false;
  const int64_t last = ring_.lastPushUs();
  const bool quiet = last == 0 || nowUs - last > 1'000'000;
  return quiet && (IsIconic(target_.hwnd) || !IsWindowVisible(target_.hwnd));
}

void WgcCapture::setCursor(bool enabled) {
  std::lock_guard lock(mutex_);
  cursor_ = enabled;
  if (session_ && features_.cursorToggle) session_.IsCursorCaptureEnabled(enabled);
}

void WgcCapture::setFrameRate(double fps) {
  std::lock_guard lock(mutex_);
  fps_ = fps;
  applyMinUpdateInterval(fps);
}

} // namespace nexo
