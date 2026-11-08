#pragma once
// Hand-off between the capture side (WGC callback / test pattern) and the encode thread: latest frame wins.
//
// The capture side copies each frame into one of a few textures we own and returns the WGC buffer at once
// (SPEC-BETA §4.2). The encode thread leases the newest slot while it converts it; the writer never touches a
// leased slot. All GPU work goes through the same multithread-protected immediate context, so command order on
// the GPU follows submission order and a lease only has to cover the CPU-side submission.

#include <d3d11.h>
#include <winrt/base.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <mutex>
#include <optional>

#include "video/output_size.hpp"

namespace nexo {

class FrameRing {
 public:
  explicit FrameRing(winrt::com_ptr<ID3D11Device> device);

  /// Auto-reset event signaled on every push, so the encode thread can react to a frame right away instead
  /// of on a fixed grid (two free-running 60 Hz clocks drift and drop frames).
  HANDLE frameEvent() const { return frameEvent_.get(); }

  /// Copies the `content` region (top-left) of `src` into a free slot and publishes it as the latest frame.
  /// Called from the capture thread. Returns false if no slot was free (the frame is dropped).
  bool push(ID3D11DeviceContext* context, ID3D11Texture2D* src, Size content, int64_t timestampUs);

  struct Frame {
    ID3D11Texture2D* texture = nullptr; ///< valid while leased
    Size size;
    int64_t timestampUs = 0;
    uint64_t seq = 0; ///< 1, 2, 3… in push order
  };

  /// Leases the newest frame (nullopt before the first push). Call release() when done submitting GPU work.
  std::optional<Frame> acquire();
  void release();

  /// Frames pushed since start (capture fps comes from deltas of this).
  uint64_t pushed() const { return pushed_.load(); }
  /// Microsecond timestamp (steady clock) of the last push, 0 if none.
  int64_t lastPushUs() const { return lastPushUs_.load(); }

 private:
  static constexpr int kSlots = 3;
  struct Slot {
    winrt::com_ptr<ID3D11Texture2D> texture;
    Size textureSize;
    Size content;
    int64_t timestampUs = 0;
    uint64_t seq = 0;
  };

  bool ensureTexture(Slot& slot, Size size, DXGI_FORMAT format);

  winrt::com_ptr<ID3D11Device> device_;
  std::mutex mutex_;
  std::array<Slot, kSlots> slots_{};
  int latest_ = -1;
  int leased_ = -1;
  uint64_t nextSeq_ = 1;
  std::atomic<uint64_t> pushed_{0};
  std::atomic<int64_t> lastPushUs_{0};
  winrt::handle frameEvent_;
};

/// QueryPerformanceCounter in microseconds: the clock WGC's SystemRelativeTime uses.
int64_t qpcMicros();

} // namespace nexo
