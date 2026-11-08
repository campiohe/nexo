#pragma once
// Encode pacing and degradation policy (SPEC-BETA §4.2, §4.4, §4.6, §4.9). Pure logic: no clocks, no D3D.
// Time is passed in as microseconds so the tests can drive it.
//
// The encode thread calls onTick() once per tick (1/fps()). The pacer answers whether to encode, whether the
// frame is a repeat of the last captured one (idle refresh or a keyframe on a static screen), and whether to
// force an IDR. LiveKit's congestion feedback goes through onRateControl(); the resulting encoder settings are
// read with takeRateChange().

#include <cstdint>
#include <optional>
#include <vector>

#include "ipc/protocol.hpp"
#include "video/output_size.hpp"

namespace nexo {

enum class RateMode { Cbr, PeakConstrainedVbr };

/// What the MF encoder should be set to.
struct EncoderRates {
  RateMode mode = RateMode::Cbr;
  uint64_t meanBitrate = 0;
  uint64_t peakBitrate = 0; ///< PeakConstrainedVbr only (0 for CBR)
  std::optional<uint32_t> maxQp;
  friend bool operator==(const EncoderRates&, const EncoderRates&) = default;
};

struct PacerConfig {
  double presetFps = 60;
  uint64_t maxBitrate = 6'000'000;
  ipc::ContentHint hint = ipc::ContentHint::Motion;
  Size output{1920, 1080};
  /// detail: max QP so small text stays readable when bandwidth drops (SPEC-BETA §4.9).
  uint32_t detailMaxQp = 30;
  /// detail: mean = peak × this (peak-constrained VBR).
  double detailMeanRatio = 0.6;
};

class Pacer {
 public:
  static constexpr int64_t kIdleRefreshUs = 1'000'000;   ///< re-encode a static frame at least once per second
  static constexpr int64_t kMinKeyframeGapUs = 500'000;  ///< at most one forced IDR every 500 ms
  static constexpr double kRateChangeThreshold = 0.05;   ///< apply bitrate changes larger than 5%
  static constexpr double kMotionMinFps = 30;
  static constexpr double kDetailMinFps = 5;

  explicit Pacer(PacerConfig config);

  /// Live preset change (update command). Keeps feedback and keyframe state.
  void reconfigure(PacerConfig config);
  const PacerConfig& config() const { return config_; }

  /// LiveKit `rate_control` feedback. The fps value is recorded but not used to cap the tick rate: libwebrtc
  /// reports its *input* frame-rate estimate there, so following it would lock an idle screen share (1 fps
  /// refreshes) at 1 fps forever.
  void onRateControl(uint64_t targetBitrateBps, double framerateFps);
  void requestKeyframe() { keyframePending_ = true; }

  struct Decision {
    bool encode = false;
    bool repeat = false;   ///< re-encode the last captured frame (nothing new arrived)
    bool keyframe = false; ///< force an IDR
  };
  Decision onTick(int64_t nowUs, bool newFrame, bool haveFrame);
  /// The encoder accepted a frame (call after onTick said encode and the submit succeeded).
  void onSubmitted(int64_t nowUs, bool keyframe);

  /// Current encode rate after degradation, never above the preset.
  double fps() const { return fps_; }
  int64_t tickIntervalUs() const;
  /// LiveKit's target capped by the preset maximum (the preset max until the first feedback).
  uint64_t targetBitrate() const { return target_; }
  std::optional<double> feedbackFps() const { return feedbackFps_; }
  bool keyframePending() const { return keyframePending_; }

  /// Encoder settings for the current target and fps.
  EncoderRates encoderRates() const;
  /// encoderRates() when it differs enough from what was last taken (mode/QP change or > 5% bitrate change).
  std::optional<EncoderRates> takeRateChange();

  /// Below this a motion share steps its fps down (≈ 1.5 Mbps at 1080p, scaled by pixel count).
  uint64_t motionFloorBitrate() const;

 private:
  void updateFps();
  std::vector<double> fpsSteps() const;

  PacerConfig config_;
  uint64_t target_ = 0;
  double fps_ = 0;
  std::optional<double> feedbackFps_;
  std::optional<EncoderRates> applied_;
  bool keyframePending_ = true; // the first frame must be an IDR
  std::optional<int64_t> lastKeyframeUs_;
  std::optional<int64_t> lastEncodeUs_;
};

} // namespace nexo
