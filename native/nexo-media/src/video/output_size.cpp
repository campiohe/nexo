#include "video/output_size.hpp"

#include <algorithm>
#include <cmath>

namespace nexo {
namespace {

uint32_t evenDown(double v) {
  // The epsilon absorbs 1279.9999… from 1280/1366*1366.
  auto i = static_cast<uint32_t>(std::floor(v + 1e-6));
  return i & ~1u;
}

int32_t evenNearest(double v) {
  return static_cast<int32_t>(std::lround(v / 2.0) * 2);
}

} // namespace

Size pickOutputSize(Size source, Size box) {
  constexpr uint32_t kMin = 16;
  if (source.width == 0 || source.height == 0) return {std::max(kMin, box.width & ~1u), std::max(kMin, box.height & ~1u)};
  const double scale = std::min({1.0, static_cast<double>(box.width) / source.width,
                                 static_cast<double>(box.height) / source.height});
  Size out{evenDown(source.width * scale), evenDown(source.height * scale)};
  // Floating error (e.g. 1919.9999) must not cost a whole pixel pair when the source fits exactly.
  if (scale == 1.0) out = {source.width & ~1u, source.height & ~1u};
  out.width = std::max(out.width, kMin);
  out.height = std::max(out.height, kMin);
  return out;
}

Rect letterboxRect(Size content, Size output) {
  if (content.width == 0 || content.height == 0 || output.width == 0 || output.height == 0) {
    return {0, 0, static_cast<int32_t>(output.width), static_cast<int32_t>(output.height)};
  }
  const double scale = std::min(static_cast<double>(output.width) / content.width,
                                static_cast<double>(output.height) / content.height);
  const int32_t w = std::clamp(evenNearest(content.width * scale), 2, static_cast<int32_t>(output.width));
  const int32_t h = std::clamp(evenNearest(content.height * scale), 2, static_cast<int32_t>(output.height));
  const int32_t left = ((static_cast<int32_t>(output.width) - w) / 2) & ~1;
  const int32_t top = ((static_cast<int32_t>(output.height) - h) / 2) & ~1;
  return {left, top, left + w, top + h};
}

} // namespace nexo
