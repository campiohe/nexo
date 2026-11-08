#include "video/pacer.hpp"

#include <algorithm>
#include <cmath>
#include <span>

namespace nexo {
namespace {

constexpr double kHysteresis = 1.1; // step back up only with 10% headroom, so the fps doesn't flap

double relativeChange(uint64_t a, uint64_t b) {
  if (b == 0) return a == 0 ? 0.0 : 1.0;
  return std::abs(static_cast<double>(a) - static_cast<double>(b)) / static_cast<double>(b);
}

} // namespace

Pacer::Pacer(PacerConfig config) : config_(config), target_(config.maxBitrate), fps_(config.presetFps) {}

void Pacer::reconfigure(PacerConfig config) {
  config_ = config;
  // A lower preset max applies immediately; a higher one is reached as LiveKit's feedback allows.
  target_ = std::min(target_ == 0 ? config.maxBitrate : target_, config.maxBitrate);
  fps_ = std::min(fps_, config.presetFps);
  updateFps();
}

void Pacer::onRateControl(uint64_t targetBitrateBps, double framerateFps) {
  if (targetBitrateBps > 0) target_ = std::min(targetBitrateBps, config_.maxBitrate);
  if (framerateFps > 0) feedbackFps_ = framerateFps;
  updateFps();
}

uint64_t Pacer::motionFloorBitrate() const {
  const double pixels = static_cast<double>(config_.output.width) * config_.output.height;
  const double floor = 1'500'000.0 * pixels / (1920.0 * 1080.0);
  return static_cast<uint64_t>(std::max(300'000.0, floor));
}

std::vector<double> Pacer::fpsSteps() const {
  // Descending ladders. Motion keeps fps as long as it can and never goes under 30; detail trades fps for
  // quality all the way down to 5 (SPEC-BETA §4.9).
  static constexpr double kMotion[] = {60, 45, 30};
  static constexpr double kDetail[] = {60, 30, 20, 15, 10, 5};
  const bool detail = config_.hint == ipc::ContentHint::Detail;
  const double minFps = detail ? kDetailMinFps : kMotionMinFps;
  std::vector<double> steps{config_.presetFps};
  for (double s : detail ? std::span<const double>(kDetail) : std::span<const double>(kMotion)) {
    if (s < config_.presetFps && s >= minFps) steps.push_back(s);
  }
  return steps;
}

void Pacer::updateFps() {
  const bool detail = config_.hint == ipc::ContentHint::Detail;
  // The bitrate at which the full preset fps is affordable. Motion: the floor. Detail: half the preset max,
  // since text needs many bits per frame and is cheap to send slowly.
  const double comfortable = detail ? static_cast<double>(config_.maxBitrate) * 0.5
                                    : static_cast<double>(motionFloorBitrate());
  // Not capped at the preset: the headroom above it is what lets the hysteresis step back up to full fps.
  const double desired = config_.presetFps * static_cast<double>(target_) / comfortable;
  const auto steps = fpsSteps();

  // Largest step not above `limit`, or the lowest step.
  auto stepAtMost = [&](double limit) {
    for (double s : steps) {
      if (s <= limit + 1e-9) return s;
    }
    return steps.back();
  };

  if (desired < fps_) {
    fps_ = stepAtMost(desired);
  } else {
    const double up = stepAtMost(desired / kHysteresis);
    fps_ = std::max(fps_, up);
  }
  fps_ = std::min(fps_, config_.presetFps);
}

int64_t Pacer::tickIntervalUs() const {
  return static_cast<int64_t>(std::llround(1'000'000.0 / std::max(1.0, fps_)));
}

EncoderRates Pacer::encoderRates() const {
  // The MFT budgets bits per frame from the frame rate in its media type (the preset fps). When we feed it
  // fewer frames, scale the bitrate up so the real output still lands on the target.
  const double compensation = config_.presetFps / std::max(1.0, fps_);
  const auto scaled = static_cast<uint64_t>(static_cast<double>(target_) * compensation);
  EncoderRates r;
  if (config_.hint == ipc::ContentHint::Detail) {
    r.mode = RateMode::PeakConstrainedVbr;
    r.peakBitrate = scaled;
    r.meanBitrate = static_cast<uint64_t>(static_cast<double>(scaled) * config_.detailMeanRatio);
    r.maxQp = config_.detailMaxQp;
  } else {
    r.mode = RateMode::Cbr;
    r.meanBitrate = scaled;
  }
  return r;
}

std::optional<EncoderRates> Pacer::takeRateChange() {
  const auto rates = encoderRates();
  if (applied_ && applied_->mode == rates.mode && applied_->maxQp == rates.maxQp &&
      relativeChange(rates.meanBitrate, applied_->meanBitrate) <= kRateChangeThreshold &&
      relativeChange(rates.peakBitrate, applied_->peakBitrate) <= kRateChangeThreshold) {
    return std::nullopt;
  }
  applied_ = rates;
  return rates;
}

Pacer::Decision Pacer::onTick(int64_t nowUs, bool newFrame, bool haveFrame) {
  Decision d;
  if (!haveFrame) return d;
  const bool keyframeAllowed = !lastKeyframeUs_ || nowUs - *lastKeyframeUs_ >= kMinKeyframeGapUs;
  const bool keyframe = keyframePending_ && keyframeAllowed;
  if (newFrame) {
    d.encode = true;
  } else if (keyframe) {
    // A viewer joined or lost packets on a static screen: re-encode the last frame as an IDR now rather than
    // waiting for the content to change.
    d.encode = true;
    d.repeat = true;
  } else if (!lastEncodeUs_ || nowUs - *lastEncodeUs_ >= kIdleRefreshUs) {
    d.encode = true;
    d.repeat = true;
  }
  d.keyframe = d.encode && keyframe;
  return d;
}

void Pacer::onSubmitted(int64_t nowUs, bool keyframe) {
  lastEncodeUs_ = nowUs;
  if (keyframe) {
    lastKeyframeUs_ = nowUs;
    keyframePending_ = false;
  }
}

} // namespace nexo
