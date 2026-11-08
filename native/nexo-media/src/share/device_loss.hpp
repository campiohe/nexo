#pragma once
// What to do when the GPU device is lost (SPEC-BETA §4.3). Pure logic, time in microseconds.
//
// After DXGI_ERROR_DEVICE_REMOVED/RESET (TDR, driver update, eGPU unplug) the share rebuilds its device,
// capture, converter and encoder while the LiveKit track stays published. A rebuild can fail while the driver
// is still coming back, so it is retried once after a delay; the second failure ends the share (device-lost).
// A device that keeps dying right after each rebuild (a crash loop) also ends it, instead of flickering forever.

#include <cstdint>
#include <deque>
#include <optional>

namespace nexo {

class DeviceLossPolicy {
 public:
  struct Config {
    int maxAttempts = 2;                ///< rebuild attempts per loss ("fails twice" → give up)
    int64_t retryDelayUs = 2'000'000;   ///< a TDR takes ~2 s to bring the driver back
    int maxLosses = 3;                  ///< losses tolerated within `lossWindowUs`
    int64_t lossWindowUs = 60'000'000;
  };

  DeviceLossPolicy() = default;
  explicit DeviceLossPolicy(Config config) : config_(config) {}

  /// A loss was detected. False: give up now (too many losses lately).
  bool onLoss(int64_t nowUs);
  /// A rebuild attempt failed. The delay before the next attempt, or nullopt to give up.
  std::optional<int64_t> onRebuildFailed();
  void onRebuilt() { attempts_ = 0; }

  int attempts() const { return attempts_; }
  uint64_t losses() const { return totalLosses_; }

 private:
  Config config_;
  std::deque<int64_t> recent_;
  int attempts_ = 0;
  uint64_t totalLosses_ = 0;
};

} // namespace nexo
