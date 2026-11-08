#include "share/device_loss.hpp"

namespace nexo {

bool DeviceLossPolicy::onLoss(int64_t nowUs) {
  ++totalLosses_;
  attempts_ = 0;
  recent_.push_back(nowUs);
  while (!recent_.empty() && nowUs - recent_.front() > config_.lossWindowUs) recent_.pop_front();
  return static_cast<int>(recent_.size()) <= config_.maxLosses;
}

std::optional<int64_t> DeviceLossPolicy::onRebuildFailed() {
  if (++attempts_ >= config_.maxAttempts) return std::nullopt;
  return config_.retryDelayUs;
}

} // namespace nexo
