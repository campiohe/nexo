#include <algorithm>
#include <cmath>
#include <vector>

#include "audio/audio_framer.hpp"
#include "test.hpp"

using nexo::AudioFramer;
using nexo::AudioFramerConfig;

namespace {

constexpr int64_t ms = 1000;
constexpr size_t kFrameLen = 480 * 2; // 10 ms stereo at 48 kHz

struct Sink {
  std::vector<std::vector<int16_t>> frames;
  std::vector<bool> fill;
  AudioFramer::EmitFn fn() {
    return [this](std::span<const int16_t> f, bool silence) {
      frames.emplace_back(f.begin(), f.end());
      fill.push_back(silence);
    };
  }
  size_t fills() const {
    size_t n = 0;
    for (bool f : fill) n += f ? 1 : 0;
    return n;
  }
};

std::vector<int16_t> ramp(size_t samplesPerChannel, int16_t start) {
  std::vector<int16_t> v(samplesPerChannel * 2);
  for (size_t i = 0; i < samplesPerChannel; ++i) {
    v[2 * i] = static_cast<int16_t>(start + static_cast<int16_t>(i));
    v[2 * i + 1] = static_cast<int16_t>(-(start + static_cast<int16_t>(i)));
  }
  return v;
}

} // namespace

TEST_CASE("audio", "uneven packets are re-cut into exact 10 ms frames, in order") {
  AudioFramer f;
  Sink sink;
  f.start(0);
  // 1000 samples per channel arrive as 300 + 450 + 250 → two full frames (960) and 40 pending.
  const auto all = ramp(1000, 1);
  f.push(std::span(all).subspan(0, 600));
  f.push(std::span(all).subspan(600, 900));
  f.push(std::span(all).subspan(1500, 500));
  CHECK_EQ(f.drain(5 * ms, sink.fn()), size_t{2});
  CHECK_EQ(sink.frames.size(), size_t{2});
  CHECK_EQ(sink.frames[0].size(), kFrameLen);
  CHECK_EQ(sink.frames[0][0], int16_t{1});
  CHECK_EQ(sink.frames[0][1], int16_t{-1});
  CHECK_EQ(sink.frames[1][0], int16_t{481}); // continues exactly where frame 0 ended
  CHECK_EQ(f.pendingSamples(), size_t{40});
  CHECK_EQ(sink.fills(), size_t{0});
}

TEST_CASE("audio", "device-silent packets count as real time, not as fill") {
  AudioFramer f;
  Sink sink;
  f.start(0);
  f.pushSilent(480);
  CHECK_EQ(f.drain(10 * ms, sink.fn()), size_t{1});
  CHECK(!sink.fill[0]);
  CHECK_EQ(sink.frames[0][100], int16_t{0});
  CHECK_EQ(f.capturedFrames(), uint64_t{1});
}

TEST_CASE("audio", "no silence is inserted while packets flow with normal jitter") {
  AudioFramer f;
  Sink sink;
  f.start(0);
  // Packet i is due at (i+1)*10 ms and arrives up to 15 ms late; the thread wakes every 5 ms (its wait
  // timeout or the WASAPI event). Gaps between captures stay under the 30 ms threshold: never a fill.
  std::vector<int64_t> arrival;
  int64_t prev = 0;
  for (int i = 0; i < 500; ++i) {
    const int64_t jitter = (i % 7 == 0) ? 15 * ms : (i % 3) * ms;
    prev = std::max(prev, (i + 1) * 10 * ms + jitter);
    arrival.push_back(prev);
  }
  size_t next = 0;
  for (int64_t t = 5 * ms; next < arrival.size(); t += 5 * ms) {
    while (next < arrival.size() && arrival[next] <= t) {
      f.push(ramp(480, 0));
      ++next;
    }
    f.drain(t, sink.fn());
  }
  CHECK_EQ(sink.fills(), size_t{0});
  CHECK_EQ(f.capturedFrames(), uint64_t{500});
}

TEST_CASE("audio", "a quiet source is filled on a 10 ms cadence after the gap") {
  AudioFramer f;
  Sink sink;
  f.start(0);
  f.push(ramp(480, 0));
  f.drain(10 * ms, sink.fn()); // position 1 at t = 10 ms, last capture at 10 ms
  // Wake every 10 ms (the capture thread's wait timeout) with nothing captured.
  size_t at40 = 0;
  for (int64_t t = 20 * ms; t <= 200 * ms; t += 10 * ms) {
    f.drain(t, sink.fn());
    if (t == 30 * ms) CHECK_EQ(sink.fills(), size_t{0}); // 20 ms quiet: still inside the gap
    if (t == 40 * ms) at40 = sink.fills();
  }
  CHECK_EQ(at40, size_t{3}); // first fill at the gap catches up to the wall clock (frames 2..4)
  // From t = 0 to 200 ms the stream holds exactly 20 frames: 1 captured + 19 fill.
  CHECK_EQ(sink.frames.size(), size_t{20});
  CHECK_EQ(sink.fills(), size_t{19});
  for (size_t i = 1; i < sink.frames.size(); ++i) CHECK_EQ(sink.frames[i][7], int16_t{0});
}

TEST_CASE("audio", "the tail of the last sound is flushed, padded, before silence") {
  AudioFramer f;
  Sink sink;
  f.start(0);
  f.push(ramp(480 + 100, 1)); // one frame + 100 samples of tail
  f.drain(10 * ms, sink.fn());
  CHECK_EQ(f.pendingSamples(), size_t{100});
  f.drain(55 * ms, sink.fn()); // quiet past the gap: 4 frames due → padded tail + 3 fill
  CHECK_EQ(sink.frames.size(), size_t{5});
  CHECK(!sink.fill[1]);
  CHECK_EQ(sink.frames[1][0], int16_t{481});      // tail first
  CHECK_EQ(sink.frames[1][2 * 100], int16_t{0});  // then zero padding
  CHECK_EQ(sink.fills(), size_t{3});
  CHECK_EQ(f.pendingSamples(), size_t{0});
}

TEST_CASE("audio", "a device clock slower than QPC never causes a fill mid-audio") {
  AudioFramer f;
  Sink sink;
  f.start(0);
  // 200 ppm slow device for 10 minutes: 0.12 s of drift, far more than one gap.
  double t = 0;
  for (int i = 0; i < 60'000; ++i) {
    t += 10'002.0;
    f.push(ramp(480, 0));
    f.drain(static_cast<int64_t>(t), sink.fn());
  }
  CHECK_EQ(sink.fills(), size_t{0});
  CHECK(f.reanchors() >= 1); // the drift was absorbed by moving the anchor
}

TEST_CASE("audio", "a long stall re-anchors instead of bursting silence") {
  AudioFramer f;
  Sink sink;
  f.start(0);
  f.push(ramp(480, 0));
  f.drain(10 * ms, sink.fn());
  f.drain(1010 * ms, sink.fn()); // the thread was away for a second: 100 frames due
  CHECK_EQ(sink.fills(), size_t{0});
  CHECK_EQ(f.reanchors(), uint64_t{1});
  f.drain(1020 * ms, sink.fn()); // back to the normal cadence from the new anchor
  CHECK_EQ(sink.fills(), size_t{1});
}

TEST_CASE("audio", "audio resuming after a fill continues without a fill in between") {
  AudioFramer f;
  Sink sink;
  f.start(0);
  for (int64_t t = 10 * ms; t <= 100 * ms; t += 10 * ms) f.drain(t, sink.fn());
  const size_t filled = sink.fills();
  CHECK_EQ(filled, size_t{10});
  for (int64_t t = 110 * ms; t <= 300 * ms; t += 10 * ms) {
    f.push(ramp(480, 5));
    f.drain(t, sink.fn());
  }
  CHECK_EQ(sink.fills(), filled);
  CHECK_EQ(sink.frames.size(), size_t{30}); // 300 ms of stream, 30 frames
}

TEST_CASE("audio", "level and WAV header") {
  std::vector<int16_t> silence(960, 0);
  CHECK_EQ(nexo::measureLevel(silence).rms, 0.0);
  CHECK_EQ(nexo::measureLevel(silence).rmsDbfs, -120.0);
  std::vector<int16_t> square(960);
  for (size_t i = 0; i < square.size(); ++i) square[i] = (i % 2) ? 16384 : -16384;
  const auto level = nexo::measureLevel(square);
  CHECK(std::abs(level.rms - 0.5) < 1e-9);
  CHECK(std::abs(level.rmsDbfs - (-6.0206)) < 1e-3);
  CHECK_EQ(level.peak, int16_t{16384});

  const auto h = nexo::wavHeader(48000, 2, 1920);
  CHECK_EQ(h.size(), size_t{44});
  CHECK(h[0] == 'R' && h[8] == 'W' && h[36] == 'd');
  CHECK_EQ(h[4] | (h[5] << 8), 36 + 1920);
  CHECK_EQ(h[22], uint8_t{2});                               // channels
  CHECK_EQ(h[24] | (h[25] << 8) | (h[26] << 16), 48000);     // sample rate
  CHECK_EQ(h[32], uint8_t{4});                               // block align
  CHECK_EQ(h[40] | (h[41] << 8), 1920);                      // data bytes
}
