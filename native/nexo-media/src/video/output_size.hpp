#pragma once
// Output size and letterboxing (SPEC-BETA §4.5). Pure arithmetic, unit-tested.

#include <cstdint>

namespace nexo {

struct Size {
  uint32_t width = 0;
  uint32_t height = 0;
  friend bool operator==(const Size&, const Size&) = default;
};

struct Rect {
  int32_t left = 0;
  int32_t top = 0;
  int32_t right = 0;
  int32_t bottom = 0;
  int32_t width() const { return right - left; }
  int32_t height() const { return bottom - top; }
  friend bool operator==(const Rect&, const Rect&) = default;
};

/// The share's encoded size, picked once at start: the source's aspect ratio fit inside `box`, never upscaled,
/// rounded down to even dimensions (NV12/H.264 4:2:0 needs even sizes). Minimum 16×16.
Size pickOutputSize(Size source, Size box);

/// Where `content` lands inside `output` when it is scaled to fit and centered (black bars elsewhere).
/// Edges are even so chroma doesn't bleed into the bars. Used after the source is resized mid-share, since the
/// output size never changes (EncodedVideoSource has a fixed size).
Rect letterboxRect(Size content, Size output);

} // namespace nexo
