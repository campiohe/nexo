#pragma once
// Image files through WIC (Windows Imaging Component): PNG out, any WIC format in. Used by --scaler-compare.

#include <cstdint>
#include <filesystem>
#include <vector>

namespace nexo {

struct BgraImage {
  uint32_t width = 0;
  uint32_t height = 0;
  std::vector<uint8_t> pixels; ///< BGRA, tightly packed (stride = width * 4)
};

/// Throws HrError.
void savePng(const std::filesystem::path& path, const BgraImage& image);
BgraImage loadImage(const std::filesystem::path& path);

} // namespace nexo
