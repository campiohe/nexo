#include "video/annexb.hpp"

namespace nexo::h264 {
namespace {

constexpr uint8_t kStartCode[] = {0, 0, 0, 1};

void appendNal(std::vector<uint8_t>& out, const std::vector<uint8_t>& nal) {
  out.insert(out.end(), std::begin(kStartCode), std::end(kStartCode));
  out.insert(out.end(), nal.begin(), nal.end());
}

} // namespace

std::vector<Nal> splitNals(std::span<const uint8_t> au) {
  std::vector<Nal> nals;
  const size_t n = au.size();
  // Find each 00 00 01; a preceding 00 makes it a 4-byte start code.
  auto findStart = [&](size_t from) -> size_t {
    for (size_t k = from; k + 2 < n; ++k) {
      if (au[k] == 0 && au[k + 1] == 0 && au[k + 2] == 1) return k;
    }
    return n;
  };
  size_t sc = findStart(0);
  while (sc < n) {
    const size_t scStart = (sc > 0 && au[sc - 1] == 0) ? sc - 1 : sc;
    const size_t header = sc + 3;
    const size_t next = findStart(header);
    size_t end = next;
    // Trailing zeros belong to the next start code (or are trailing_zero_8bits), not to this NAL.
    while (end > header && au[end - 1] == 0) --end;
    if (header < n) {
      Nal nal;
      nal.offset = scStart;
      nal.headerOffset = header;
      nal.end = end;
      nal.type = au[header] & 0x1F;
      nals.push_back(nal);
    }
    sc = next;
  }
  return nals;
}

bool containsIdr(std::span<const uint8_t> au) {
  for (const auto& nal : splitNals(au)) {
    if (nal.type == kNalIdr) return true;
  }
  return false;
}

std::optional<SpsInfo> parseSpsHeader(std::span<const uint8_t> spsNal) {
  if (spsNal.size() < 4 || (spsNal[0] & 0x1F) != kNalSps) return std::nullopt;
  return SpsInfo{spsNal[1], spsNal[2], spsNal[3]};
}

void ParameterSetCache::seed(std::span<const uint8_t> annexB) {
  observe(annexB, splitNals(annexB));
}

void ParameterSetCache::observe(std::span<const uint8_t> au, const std::vector<Nal>& nals) {
  for (const auto& nal : nals) {
    auto payload = nal.payload(au);
    if (payload.empty()) continue;
    if (nal.type == kNalSps) sps_.assign(payload.begin(), payload.end());
    if (nal.type == kNalPps) pps_.assign(payload.begin(), payload.end());
  }
}

std::vector<uint8_t> ParameterSetCache::process(std::span<const uint8_t> au, bool* repaired) {
  if (repaired) *repaired = false;
  const auto nals = splitNals(au);
  observe(au, nals);

  bool idr = false, hasSps = false, hasPps = false;
  size_t firstIdr = au.size();
  for (const auto& nal : nals) {
    if (nal.type == kNalIdr) {
      if (!idr) firstIdr = nal.offset;
      idr = true;
    }
    if (nal.type == kNalSps) hasSps = true;
    if (nal.type == kNalPps) hasPps = true;
  }
  if (!idr || (hasSps && hasPps) || !hasParameterSets()) return {au.begin(), au.end()};

  // Insert the missing sets right before the first IDR slice, after any AUD/SEI, so the AUD (if present)
  // stays the first NAL of the access unit as the spec requires.
  std::vector<uint8_t> out;
  out.reserve(au.size() + sps_.size() + pps_.size() + 8);
  out.insert(out.end(), au.begin(), au.begin() + static_cast<ptrdiff_t>(firstIdr));
  if (!hasSps) appendNal(out, sps_);
  if (!hasPps) appendNal(out, pps_);
  out.insert(out.end(), au.begin() + static_cast<ptrdiff_t>(firstIdr), au.end());
  if (repaired) *repaired = true;
  return out;
}

} // namespace nexo::h264
