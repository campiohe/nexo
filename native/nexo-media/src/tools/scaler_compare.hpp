#pragma once
// --scaler-compare: one frame through every `detail` scaler, written as PNGs (SPEC-BETA §4.9, M3).

#include <windows.h>

#include <filesystem>
#include <optional>
#include <vector>

#include "video/output_size.hpp"

namespace nexo {

struct ScalerCompareOptions {
  HMONITOR monitor = nullptr;                ///< capture one frame of this monitor…
  std::optional<std::filesystem::path> image; ///< …or use this image file instead
  std::filesystem::path outDir;
  std::vector<Size> boxes{{1920, 1080}};     ///< preset boxes; the output fits the source inside each
  std::optional<Rect> crop;                  ///< region of the output to also write enlarged (pixel-exact)
  uint32_t zoom = 4;
};

/// Writes source.png and <W>x<H>-<scaler>.png for vp / bicubic / lanczos (plus -crop.png with a crop).
/// Prints one JSON line per file. Returns the process exit code.
int runScalerCompare(const ScalerCompareOptions& options);

} // namespace nexo
