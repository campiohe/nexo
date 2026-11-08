#pragma once
// H.264 Annex B helpers: NAL splitting, keyframe detection and the SPS/PPS repair of SPEC-BETA §4.6
// ("SPS + PPS on every IDR"). Pure byte logic, unit-tested.

#include <cstdint>
#include <optional>
#include <span>
#include <vector>

namespace nexo::h264 {

enum NalType : uint8_t {
  kNalSlice = 1,
  kNalIdr = 5,
  kNalSei = 6,
  kNalSps = 7,
  kNalPps = 8,
  kNalAud = 9,
};

struct Nal {
  size_t offset = 0;      ///< Start of the start code.
  size_t headerOffset = 0; ///< First byte after the start code (the NAL header).
  size_t end = 0;         ///< One past the last payload byte (trailing zero bytes excluded).
  uint8_t type = 0;

  std::span<const uint8_t> payload(std::span<const uint8_t> au) const {
    return au.subspan(headerOffset, end - headerOffset);
  }
};

/// Splits an Annex B access unit at 3- and 4-byte start codes. Bytes before the first start code are ignored.
std::vector<Nal> splitNals(std::span<const uint8_t> au);

/// True when the access unit contains an IDR slice.
bool containsIdr(std::span<const uint8_t> au);

/// profile_idc / constraint flags / level_idc from an SPS NAL payload (header byte included).
struct SpsInfo {
  uint8_t profileIdc = 0;
  uint8_t constraints = 0;
  uint8_t levelIdc = 0;
};
std::optional<SpsInfo> parseSpsHeader(std::span<const uint8_t> spsNal);

/// Remembers the latest SPS/PPS seen and makes sure every IDR access unit carries them, because a viewer that
/// joins on a keyframe can't decode it without parameter sets, and some hardware MFTs only emit them once.
class ParameterSetCache {
 public:
  /// Seeds the cache from MF_MT_MPEG_SEQUENCE_HEADER (Annex B SPS+PPS) when the encoder provides one.
  void seed(std::span<const uint8_t> annexB);

  /// Updates the cache from `au` and returns it with the cached SPS/PPS prepended if `au` is an IDR that lacks
  /// them. Non-IDR units are returned unchanged. Sets `repaired` when bytes were inserted.
  std::vector<uint8_t> process(std::span<const uint8_t> au, bool* repaired = nullptr);

  bool hasParameterSets() const { return !sps_.empty() && !pps_.empty(); }
  const std::vector<uint8_t>& sps() const { return sps_; }
  const std::vector<uint8_t>& pps() const { return pps_; }

 private:
  void observe(std::span<const uint8_t> au, const std::vector<Nal>& nals);

  std::vector<uint8_t> sps_; ///< NAL payload without start code
  std::vector<uint8_t> pps_;
};

} // namespace nexo::h264
