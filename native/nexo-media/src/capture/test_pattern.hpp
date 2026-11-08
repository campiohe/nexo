#pragma once
// Synthetic moving pattern for `--test-pattern` (M0): color bars, a block that moves one step per frame and the
// frame number in binary, so a viewer can spot dropped or repeated frames by eye. Rendered with ClearView on
// our own device, then fed through the same ring → convert → encode → publish path as WGC frames.

#include <d3d11_1.h>

#include <atomic>
#include <memory>
#include <thread>

#include "capture/frame_ring.hpp"
#include "capture/frame_source.hpp"
#include "d3d/device.hpp"

namespace nexo {

class TestPatternSource final : public FrameSource {
 public:
  TestPatternSource(std::shared_ptr<D3DDevice> device, FrameRing& ring, Size size, double fps);
  ~TestPatternSource() override;

  Size initialSize() const override { return size_; }
  void start() override;
  void stop() override;
  bool stalled(int64_t) const override { return false; }
  bool closed() const override { return false; }
  void setFrameRate(double fps) override { fps_.store(fps); }
  std::string describe() const override;

 private:
  void run(std::stop_token stop);
  void render(uint64_t frame);

  std::shared_ptr<D3DDevice> device_;
  FrameRing& ring_;
  Size size_;
  std::atomic<double> fps_;
  winrt::com_ptr<ID3D11Texture2D> texture_;
  winrt::com_ptr<ID3D11RenderTargetView> rtv_;
  winrt::com_ptr<ID3D11DeviceContext1> context1_;
  std::jthread thread_;
};

} // namespace nexo
