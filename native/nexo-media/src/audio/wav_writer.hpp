#pragma once
// 16-bit PCM WAV file for debug dumps (--audio-dump, NEXO_MEDIA_DUMP_AUDIO). The header is rewritten with the
// final sizes on close, so a dump cut short by a crash still has a playable (if under-sized) header.

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <span>

#include "audio/audio_framer.hpp"

namespace nexo {

class WavWriter {
 public:
  WavWriter(const std::filesystem::path& path, uint32_t sampleRate, uint16_t channels)
      : sampleRate_(sampleRate), channels_(channels), file_(path, std::ios::binary | std::ios::trunc) {
    writeHeader();
  }
  ~WavWriter() { close(); }
  WavWriter(const WavWriter&) = delete;
  WavWriter& operator=(const WavWriter&) = delete;

  bool ok() const { return file_.good(); }
  void write(std::span<const int16_t> interleaved) {
    if (!file_.is_open()) return;
    // WAV is little-endian, like every Windows target.
    file_.write(reinterpret_cast<const char*>(interleaved.data()), static_cast<std::streamsize>(interleaved.size_bytes()));
    bytes_ += static_cast<uint32_t>(interleaved.size_bytes());
  }
  void close() {
    if (!file_.is_open()) return;
    file_.seekp(0);
    writeHeader();
    file_.close();
  }

 private:
  void writeHeader() {
    const auto h = wavHeader(sampleRate_, channels_, bytes_);
    file_.write(reinterpret_cast<const char*>(h.data()), static_cast<std::streamsize>(h.size()));
  }

  uint32_t sampleRate_;
  uint16_t channels_;
  uint32_t bytes_ = 0;
  std::ofstream file_;
};

} // namespace nexo
