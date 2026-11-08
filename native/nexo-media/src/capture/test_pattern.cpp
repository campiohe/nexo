#include "capture/test_pattern.hpp"

#include <windows.h>

#include <format>

#include "common/log.hpp"
#include "common/win_error.hpp"

namespace nexo {

TestPatternSource::TestPatternSource(std::shared_ptr<D3DDevice> device, FrameRing& ring, Size size, double fps)
    : device_(std::move(device)), ring_(ring), size_(size), fps_(fps) {
  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = size_.width;
  desc.Height = size_.height;
  desc.MipLevels = 1;
  desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; // what WGC delivers
  desc.SampleDesc.Count = 1;
  desc.Usage = D3D11_USAGE_DEFAULT;
  desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
  check(device_->device()->CreateTexture2D(&desc, nullptr, texture_.put()), "test pattern: CreateTexture2D");
  check(device_->device()->CreateRenderTargetView(texture_.get(), nullptr, rtv_.put()), "test pattern: CreateRenderTargetView");
  // ClearView (D3D11.1) draws the bars and blocks without any shader.
  check(device_->context()->QueryInterface(IID_PPV_ARGS(context1_.put())), "test pattern: ID3D11DeviceContext1");
}

TestPatternSource::~TestPatternSource() {
  stop();
}

std::string TestPatternSource::describe() const {
  return std::format("test pattern {}x{}@{}", size_.width, size_.height, fps_.load());
}

void TestPatternSource::start() {
  if (thread_.joinable()) return;
  thread_ = std::jthread([this](std::stop_token st) { run(st); });
}

void TestPatternSource::stop() {
  if (thread_.joinable()) {
    thread_.request_stop();
    thread_.join();
  }
}

void TestPatternSource::render(uint64_t frame) {
  const auto w = static_cast<LONG>(size_.width);
  const auto h = static_cast<LONG>(size_.height);
  auto fill = [&](LONG l, LONG t, LONG r, LONG b, float red, float green, float blue) {
    const float color[4] = {red, green, blue, 1.0f};
    const D3D11_RECT rect{l, t, r, b};
    context1_->ClearView(rtv_.get(), color, &rect, 1);
  };

  // 75% SMPTE-style bars over the top two thirds.
  static constexpr float kBars[8][3] = {{.75f, .75f, .75f}, {.75f, .75f, 0}, {0, .75f, .75f}, {0, .75f, 0},
                                        {.75f, 0, .75f},    {.75f, 0, 0},    {0, 0, .75f},    {0, 0, 0}};
  const LONG barsBottom = h * 2 / 3;
  for (LONG i = 0; i < 8; ++i) {
    fill(w * i / 8, 0, w * (i + 1) / 8, barsBottom, kBars[i][0], kBars[i][1], kBars[i][2]);
  }
  fill(0, barsBottom, w, h, .12f, .12f, .12f);

  // The moving block: one step per frame, so a skipped frame shows as a jump.
  const LONG block = std::max<LONG>(16, h / 8);
  const LONG step = std::max<LONG>(4, w / 240);
  const LONG travel = std::max<LONG>(1, w - block);
  const LONG pos = static_cast<LONG>((frame * static_cast<uint64_t>(step)) % static_cast<uint64_t>(2 * travel));
  const LONG x = pos < travel ? pos : 2 * travel - pos; // bounce
  const LONG top = barsBottom + (h - barsBottom - block) / 3;
  fill(x, top, x + block, top + block, 1, 1, 1);

  // Frame number, 24 bits, LSB first: green = 1, dark red = 0.
  const LONG bit = std::max<LONG>(4, w / 48);
  const LONG rowTop = h - bit - bit / 2;
  for (LONG i = 0; i < 24; ++i) {
    const bool on = (frame >> i) & 1;
    fill(bit / 2 + i * bit * 3 / 2, rowTop, bit / 2 + i * bit * 3 / 2 + bit, rowTop + bit, on ? 0.f : .4f, on ? 1.f : 0.f, 0);
  }
}

void TestPatternSource::run(std::stop_token stop) {
  SetThreadDescription(GetCurrentThread(), L"nexo test pattern");
  winrt::handle timer(CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS));
  if (!timer) {
    log::error("test pattern: CreateWaitableTimerExW failed");
    return;
  }
  int64_t next = qpcMicros();
  for (uint64_t frame = 0; !stop.stop_requested(); ++frame) {
    try {
      render(frame);
      ring_.push(device_->context(), texture_.get(), size_, qpcMicros());
    } catch (const std::exception& e) {
      log::error("test pattern: {}", e.what());
      break;
    }
    next += static_cast<int64_t>(1'000'000.0 / std::max(1.0, fps_.load()));
    const int64_t wait = next - qpcMicros();
    if (wait < -100'000) next = qpcMicros(); // fell far behind (debugger, suspend): don't burst to catch up
    if (wait > 0) {
      LARGE_INTEGER due;
      due.QuadPart = -wait * 10; // relative, 100 ns units
      SetWaitableTimer(timer.get(), &due, 0, nullptr, nullptr, FALSE);
      WaitForSingleObject(timer.get(), 1000);
    }
  }
}

} // namespace nexo
