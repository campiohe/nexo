#include "audio/audio_framer.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>

namespace nexo {

AudioFramer::AudioFramer(AudioFramerConfig config) : config_(config) {
  config_.channels = std::max<uint32_t>(1, config_.channels);
  config_.frameSamples = std::max<uint32_t>(1, config_.frameSamples);
  config_.frameUs = std::max<int64_t>(1, config_.frameUs);
  frame_.assign(static_cast<size_t>(config_.channels) * config_.frameSamples, 0);
}

void AudioFramer::start(int64_t nowUs) {
  anchorUs_ = nowUs;
  lastCapturedUs_ = nowUs;
  started_ = true;
}

void AudioFramer::push(std::span<const int16_t> interleaved) {
  // A torn sample (odd count for stereo) can't come from WASAPI; drop the tail rather than shift channels.
  const size_t whole = interleaved.size() - interleaved.size() % config_.channels;
  pending_.insert(pending_.end(), interleaved.begin(), interleaved.begin() + static_cast<std::ptrdiff_t>(whole));
}

void AudioFramer::pushSilent(size_t samplesPerChannel) {
  pending_.insert(pending_.end(), samplesPerChannel * config_.channels, int16_t{0});
}

int64_t AudioFramer::expectedFrames(int64_t nowUs) const {
  return nowUs <= anchorUs_ ? 0 : (nowUs - anchorUs_) / config_.frameUs;
}

void AudioFramer::reanchor(int64_t nowUs) {
  anchorUs_ = nowUs - static_cast<int64_t>(position_) * config_.frameUs;
  ++reanchors_;
}

size_t AudioFramer::drain(int64_t nowUs, const EmitFn& emit) {
  if (!started_) start(nowUs);
  const size_t frameLen = frame_.size();
  size_t emitted = 0;

  size_t offset = 0;
  while (pending_.size() - offset >= frameLen) {
    emit(std::span<const int16_t>(pending_.data() + offset, frameLen), false);
    offset += frameLen;
    ++position_;
    ++captured_;
    ++emitted;
  }
  pending_.erase(pending_.begin(), pending_.begin() + static_cast<std::ptrdiff_t>(offset));

  const int64_t tolerance = std::max<int64_t>(1, config_.gapUs / config_.frameUs);
  if (emitted > 0) {
    lastCapturedUs_ = nowUs;
    // Flowing audio sets the pace. If the count and the wall clock disagree by more than a gap (device clock
    // drift, a late burst after a fill), move the anchor instead of ever filling between captured frames.
    const int64_t drift = static_cast<int64_t>(position_) - expectedFrames(nowUs);
    if (std::llabs(drift) > tolerance) reanchor(nowUs);
    return emitted;
  }

  if (nowUs - lastCapturedUs_ < config_.gapUs) return emitted;
  int64_t due = expectedFrames(nowUs) - static_cast<int64_t>(position_);
  if (due <= 0) return emitted;
  if (due > static_cast<int64_t>(config_.maxFillBurst)) {
    // We were away far longer than a gap. Replaying that much silence at once would only add latency at the
    // receiver: restart the clock from here and resume the normal cadence.
    reanchor(nowUs);
    return emitted;
  }
  if (!pending_.empty()) {
    // The tail of the last sound: send it padded rather than holding it until the source plays again.
    std::fill(frame_.begin(), frame_.end(), int16_t{0});
    std::copy(pending_.begin(), pending_.end(), frame_.begin());
    pending_.clear();
    emit(frame_, false);
    ++position_;
    ++captured_;
    ++emitted;
    --due;
  }
  std::fill(frame_.begin(), frame_.end(), int16_t{0});
  for (; due > 0; --due) {
    emit(frame_, true);
    ++position_;
    ++silence_;
    ++emitted;
  }
  return emitted;
}

AudioLevel measureLevel(std::span<const int16_t> samples) {
  AudioLevel level;
  if (samples.empty()) {
    level.rmsDbfs = -120;
    return level;
  }
  double sum = 0;
  int peak = 0;
  for (const int16_t s : samples) {
    sum += static_cast<double>(s) * static_cast<double>(s);
    peak = std::max(peak, std::abs(static_cast<int>(s)));
  }
  level.rms = std::sqrt(sum / static_cast<double>(samples.size())) / 32768.0;
  level.rmsDbfs = level.rms > 0 ? std::max(-120.0, 20.0 * std::log10(level.rms)) : -120.0;
  level.peak = static_cast<int16_t>(std::min(peak, 32767));
  return level;
}

std::vector<uint8_t> wavHeader(uint32_t sampleRate, uint16_t channels, uint32_t dataBytes) {
  std::vector<uint8_t> h;
  h.reserve(44);
  auto tag = [&](const char* s) { h.insert(h.end(), s, s + 4); };
  auto u32 = [&](uint32_t v) {
    for (int i = 0; i < 4; ++i) h.push_back(static_cast<uint8_t>(v >> (8 * i)));
  };
  auto u16 = [&](uint16_t v) {
    h.push_back(static_cast<uint8_t>(v));
    h.push_back(static_cast<uint8_t>(v >> 8));
  };
  const uint16_t blockAlign = static_cast<uint16_t>(channels * 2);
  tag("RIFF");
  u32(36 + dataBytes);
  tag("WAVE");
  tag("fmt ");
  u32(16);
  u16(1); // PCM
  u16(channels);
  u32(sampleRate);
  u32(sampleRate * blockAlign);
  u16(blockAlign);
  u16(16);
  tag("data");
  u32(dataBytes);
  return h;
}

} // namespace nexo
