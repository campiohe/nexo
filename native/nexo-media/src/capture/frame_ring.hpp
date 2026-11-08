#pragma once
// Hand-off between the capture side (WGC callback / test pattern) and the encode thread: latest frame wins.
//
// Two ways in (SPEC-BETA §4.2, docs/benchmarks/beta-m3-fps-gap.md):
//   push()      copies the frame into a texture we own (the capture side returns its buffer at once).
//   pushHeld()  zero copy: keeps the capture's own buffer (a WGC pool surface) and gives it back with
//               `giveBack` once nothing uses it any more: superseded by a newer frame and no lease left.
// The encode thread leases the newest slot. A lease ends with release(), from any thread: right after the
// conversion is submitted, or when the encoder lets go of a frame it was handed directly (RGB input). A leased
// slot is never written or given back, so a frame can be leased several times (a repeat) and outlive newer ones.
// All GPU work goes through the same multithread-protected immediate context, so command order on the GPU follows
// submission order.

#include <d3d11.h>
#include <winrt/base.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <vector>

#include "video/output_size.hpp"

namespace nexo {

class FrameRing {
 public:
  static constexpr int kMaxSlots = 8;

  explicit FrameRing(winrt::com_ptr<ID3D11Device> device);
  /// Gives back every held capture buffer.
  ~FrameRing();
  FrameRing(const FrameRing&) = delete;
  FrameRing& operator=(const FrameRing&) = delete;

  /// Auto-reset event signaled on every push, so the encode thread can react to a frame right away instead
  /// of on a fixed grid (two free-running 60 Hz clocks drift and drop frames).
  HANDLE frameEvent() const { return frameEvent_.get(); }

  /// Copies the `content` region (top-left) of `src` into a free slot and publishes it as the latest frame.
  /// Called from the capture thread. Returns false if no slot was free (the frame is dropped).
  bool push(ID3D11DeviceContext* context, ID3D11Texture2D* src, Size content, int64_t timestampUs);

  /// Zero copy: publishes `texture` itself as the latest frame. `giveBack` returns it to its owner (called once,
  /// from whichever thread drops the last use, never under the ring's lock). False when every slot is in use:
  /// then the frame is dropped and the caller gives it back itself.
  bool pushHeld(winrt::com_ptr<ID3D11Texture2D> texture, Size content, int64_t timestampUs, std::function<void()> giveBack);

  struct Frame {
    ID3D11Texture2D* texture = nullptr; ///< valid while leased
    Size size;                          ///< content (top-left region of the texture)
    int64_t timestampUs = 0;
    uint64_t seq = 0; ///< 1, 2, 3… in push order
    int slot = -1;
    bool held = false; ///< a capture buffer (pushHeld): flush GPU work that reads it before release()
  };

  /// Leases the newest frame (nullopt before the first push). Call release(frame) when done with it.
  std::optional<Frame> acquire();
  /// Ends one lease. Thread-safe.
  void release(const Frame& frame);

  /// Frames pushed since start (capture fps comes from deltas of this).
  uint64_t pushed() const { return pushed_.load(); }
  /// Microsecond timestamp (steady clock) of the last push, 0 if none.
  int64_t lastPushUs() const { return lastPushUs_.load(); }
  /// Capture buffers currently kept (pushHeld), for profiling.
  int held() const;

 private:
  struct Slot {
    winrt::com_ptr<ID3D11Texture2D> texture;
    Size textureSize;
    Size content;
    int64_t timestampUs = 0;
    uint64_t seq = 0;
    int leases = 0;
    std::function<void()> giveBack; ///< set: `texture` is a held capture buffer, not ours
  };

  bool ensureTexture(Slot& slot, Size size, DXGI_FORMAT format);
  /// A slot that is neither the latest nor leased: oldest first. -1 when none (a new slot is added up to
  /// kMaxSlots when `grow`).
  int freeSlot(bool grow);
  /// Takes the slot's held buffer (to give back outside the lock) when nothing uses it any more.
  std::function<void()> takeIfUnused(int index);
  void published(); // counters + event, outside the lock

  winrt::com_ptr<ID3D11Device> device_;
  mutable std::mutex mutex_;
  std::vector<Slot> slots_;
  int latest_ = -1;
  uint64_t nextSeq_ = 1;
  std::atomic<uint64_t> pushed_{0};
  std::atomic<int64_t> lastPushUs_{0};
  winrt::handle frameEvent_;
};

/// QueryPerformanceCounter in microseconds: the clock WGC's SystemRelativeTime uses.
int64_t qpcMicros();

} // namespace nexo
