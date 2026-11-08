#pragma once
// Our own downscaler for `detail` shares (SPEC-BETA §4.9): separable resampling in two compute-shader passes,
// as an alternative to the D3D11 video processor's driver-defined filter.
//
// Text suffers most from downscaling (a 4K monitor sent at 1080p). The video processor's filter is whatever the
// driver implements, often bilinear-ish; here the kernel is ours: Catmull-Rom bicubic or Lanczos-2, widened by
// the scale ratio so a 2:1 downscale averages every source pixel instead of skipping some (aliasing).
// Filtering happens in gamma space (like the video processor), so the comparison is about the kernel only.

#include <d3d11.h>
#include <winrt/base.h>

#include <map>
#include <memory>
#include <string_view>

#include "d3d/device.hpp"
#include "video/output_size.hpp"

namespace nexo {

enum class ScalerKind { VideoProcessor, Bicubic, Lanczos };

/// NEXO_MEDIA_SCALER=vp|bicubic|lanczos: the scaler for `detail` shares (motion always uses the video processor).
ScalerKind scalerFromEnv();
std::string_view toString(ScalerKind kind);

class ComputeScaler {
 public:
  /// Throws HrError when the device can't run it (shader creation, formats).
  ComputeScaler(std::shared_ptr<D3DDevice> device, ScalerKind kind);

  /// Scales the top-left `content` region of `src` (BGRA/RGBA, shader-readable) into `target()` at `box`
  /// (the letterbox rectangle inside `output`); the rest of the target is black.
  void scale(ID3D11Texture2D* src, Size content, Size output, const Rect& box);

  /// RGBA8, output size, valid after scale(). The video processor reads it for the 1:1 RGB → NV12 step.
  ID3D11Texture2D* target() const { return target_.get(); }
  ScalerKind kind() const { return kind_; }

 private:
  void ensureTextures(Size output, Size intermediate);
  ID3D11ShaderResourceView* sourceView(ID3D11Texture2D* src);

  std::shared_ptr<D3DDevice> device_;
  ScalerKind kind_;
  winrt::com_ptr<ID3D11ComputeShader> horizontal_;
  winrt::com_ptr<ID3D11ComputeShader> vertical_;
  winrt::com_ptr<ID3D11Buffer> params_;
  winrt::com_ptr<ID3D11Texture2D> intermediate_; ///< RGBA16F: keeps the negative lobes between passes
  winrt::com_ptr<ID3D11ShaderResourceView> intermediateSrv_;
  winrt::com_ptr<ID3D11UnorderedAccessView> intermediateUav_;
  Size intermediateSize_;
  winrt::com_ptr<ID3D11Texture2D> target_;
  winrt::com_ptr<ID3D11UnorderedAccessView> targetUav_;
  Size targetSize_;
  // Views hold a reference to their texture, so a cached pointer can't be reused by a new texture.
  std::map<ID3D11Texture2D*, winrt::com_ptr<ID3D11ShaderResourceView>> sourceViews_;
};

} // namespace nexo
