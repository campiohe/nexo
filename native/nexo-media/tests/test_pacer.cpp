#include "test.hpp"
#include "video/pacer.hpp"

using nexo::Pacer;
using nexo::PacerConfig;
using nexo::RateMode;
using nexo::ipc::ContentHint;

namespace {
PacerConfig motion1080p60() {
  PacerConfig c;
  c.presetFps = 60;
  c.maxBitrate = 8'000'000;
  c.hint = ContentHint::Motion;
  c.output = {1920, 1080};
  return c;
}
PacerConfig detail1080p30() {
  PacerConfig c;
  c.presetFps = 30;
  c.maxBitrate = 6'000'000;
  c.hint = ContentHint::Detail;
  c.output = {1920, 1080};
  return c;
}
constexpr int64_t ms = 1000;
} // namespace

TEST_CASE("pacer", "first frame is a forced keyframe, then plain frames") {
  Pacer p(motion1080p60());
  CHECK(!p.onTick(0, false, false).encode); // nothing captured yet
  auto d = p.onTick(16 * ms, true, true);
  CHECK(d.encode && !d.repeat && d.keyframe);
  p.onSubmitted(16 * ms, d.keyframe);
  d = p.onTick(33 * ms, true, true);
  CHECK(d.encode && !d.keyframe);
}

TEST_CASE("pacer", "idle content: skip ticks, refresh once per second") {
  Pacer p(motion1080p60());
  auto d = p.onTick(0, true, true);
  p.onSubmitted(0, d.keyframe);
  int encodes = 0;
  for (int64_t t = 16 * ms; t < 999 * ms; t += 16 * ms) {
    if (p.onTick(t, false, true).encode) ++encodes;
  }
  CHECK_EQ(encodes, 0);
  d = p.onTick(1000 * ms, false, true);
  CHECK(d.encode && d.repeat && !d.keyframe);
}

TEST_CASE("pacer", "keyframe requests are limited to one per 500 ms") {
  Pacer p(motion1080p60());
  auto d = p.onTick(0, true, true);
  p.onSubmitted(0, d.keyframe);
  p.requestKeyframe();
  d = p.onTick(100 * ms, true, true);
  CHECK(d.encode && !d.keyframe); // too soon: frame goes out as a delta, request stays pending
  CHECK(p.keyframePending());
  p.onSubmitted(100 * ms, false);
  d = p.onTick(500 * ms, true, true);
  CHECK(d.keyframe);
  p.onSubmitted(500 * ms, true);
  CHECK(!p.keyframePending());
}

TEST_CASE("pacer", "keyframe request on a static screen re-encodes the last frame") {
  Pacer p(motion1080p60());
  auto d = p.onTick(0, true, true);
  p.onSubmitted(0, true);
  p.requestKeyframe();
  d = p.onTick(600 * ms, false, true);
  CHECK(d.encode && d.repeat && d.keyframe);
}

TEST_CASE("pacer", "bitrate follows feedback, capped by the preset") {
  Pacer p(motion1080p60());
  CHECK_EQ(p.targetBitrate(), uint64_t{8'000'000});
  p.onRateControl(20'000'000, 60);
  CHECK_EQ(p.targetBitrate(), uint64_t{8'000'000});
  p.onRateControl(4'000'000, 60);
  CHECK_EQ(p.targetBitrate(), uint64_t{4'000'000});
  CHECK_EQ(p.fps(), 60.0);
}

TEST_CASE("pacer", "rate changes apply only above 5%") {
  Pacer p(motion1080p60());
  auto first = p.takeRateChange();
  CHECK(first.has_value());
  CHECK(first->mode == RateMode::Cbr);
  CHECK_EQ(first->meanBitrate, uint64_t{8'000'000});
  p.onRateControl(7'700'000, 60); // -3.75%
  CHECK(!p.takeRateChange().has_value());
  p.onRateControl(7'000'000, 60); // -12.5% from the applied 8 M
  auto next = p.takeRateChange();
  CHECK(next.has_value());
  CHECK_EQ(next->meanBitrate, uint64_t{7'000'000});
}

TEST_CASE("pacer", "motion: fps steps down below the floor, never under 30") {
  Pacer p(motion1080p60());
  CHECK_EQ(p.motionFloorBitrate(), uint64_t{1'500'000});
  p.onRateControl(1'200'000, 60); // 80% of the floor -> 48 desired -> 45 step
  CHECK_EQ(p.fps(), 45.0);
  p.onRateControl(300'000, 60);
  CHECK_EQ(p.fps(), 30.0);
  // CBR compensated for the lower fps so the real output stays on target.
  auto r = p.encoderRates();
  CHECK_EQ(r.meanBitrate, uint64_t{600'000});
  // Recovery needs 10% headroom over the step.
  p.onRateControl(1'500'000, 60);
  CHECK_EQ(p.fps(), 45.0);
  p.onRateControl(1'700'000, 60);
  CHECK_EQ(p.fps(), 60.0);
}

TEST_CASE("pacer", "motion: a 30 fps preset never changes fps") {
  auto c = motion1080p60();
  c.presetFps = 30;
  Pacer p(c);
  p.onRateControl(200'000, 30);
  CHECK_EQ(p.fps(), 30.0);
}

TEST_CASE("pacer", "detail: peak-constrained VBR with max QP, fps down to 5") {
  Pacer p(detail1080p30());
  auto r = p.encoderRates();
  CHECK(r.mode == RateMode::PeakConstrainedVbr);
  CHECK_EQ(r.peakBitrate, uint64_t{6'000'000});
  CHECK_EQ(r.meanBitrate, uint64_t{3'600'000});
  CHECK(r.maxQp.has_value());
  p.onRateControl(1'500'000, 30); // half of comfortable (3 M) -> 15 fps
  CHECK_EQ(p.fps(), 15.0);
  p.onRateControl(100'000, 30);
  CHECK_EQ(p.fps(), 5.0);
  CHECK_EQ(p.tickIntervalUs(), int64_t{200'000});
}

TEST_CASE("pacer", "feedback fps is recorded, not obeyed") {
  Pacer p(motion1080p60());
  p.onRateControl(8'000'000, 1.0);
  CHECK_EQ(p.fps(), 60.0);
  CHECK(p.feedbackFps().has_value());
}

TEST_CASE("pacer", "reconfigure lowers the cap immediately") {
  Pacer p(motion1080p60());
  auto c = motion1080p60();
  c.maxBitrate = 3'000'000;
  c.presetFps = 30;
  p.reconfigure(c);
  CHECK_EQ(p.targetBitrate(), uint64_t{3'000'000});
  CHECK_EQ(p.fps(), 30.0);
  CHECK_EQ(p.tickIntervalUs(), int64_t{33'333});
}
