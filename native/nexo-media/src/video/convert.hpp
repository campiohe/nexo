#pragma once
// BGRA capture → NV12 encoder input on the GPU with ID3D11VideoProcessor (SPEC-BETA §4.5): scale to the fixed
// output size keeping the aspect ratio (black bars), BT.709 limited range.
//
// For `detail` the scaling step can be ours instead (SPEC-BETA §4.9, NEXO_MEDIA_SCALER=bicubic|lanczos): the
// compute scaler writes the letterboxed RGBA frame at the output size and the video processor only converts it
// to NV12 at 1:1.

#include <d3d11_1.h>
#include <winrt/base.h>

#include <map>
#include <memory>

#include "d3d/device.hpp"
#include "video/output_size.hpp"
#include "video/scaler_cs.hpp"

namespace nexo {

class VideoConverter {
 public:
  /// `quality`: the `detail` path: `detailScaler`, or the driver's best video-processor scaler for `vp`.
  VideoConverter(std::shared_ptr<D3DDevice> device, Size output, bool quality, ScalerKind detailScaler = scalerFromEnv());

  /// Converts the top-left `content` region of `src` into `dst` (output size, subresource `dstSlice`): NV12
  /// (BT.709 limited), or B8G8R8A8 for an encoder that takes RGB (then it only scales and letterboxes).
  /// Throws HrError on failure.
  void convert(ID3D11Texture2D* src, Size content, ID3D11Texture2D* dst, UINT dstSlice);

  Size output() const { return output_; }
  /// motion ↔ detail mid-share: switches the scaler (takes effect on the next convert()).
  void setDetail(bool detail);
  /// The scaler convert() uses for frames that need scaling.
  ScalerKind activeScaler() const { return quality_ ? detailScaler_ : ScalerKind::VideoProcessor; }

 private:
  void ensureProcessor(Size input, DXGI_FORMAT format, DXGI_FORMAT outputFormat);
  ID3D11VideoProcessorInputView* inputView(ID3D11Texture2D* src);
  ID3D11VideoProcessorOutputView* outputView(ID3D11Texture2D* dst, UINT slice);

  std::shared_ptr<D3DDevice> device_;
  Size output_;
  bool quality_;
  winrt::com_ptr<ID3D11VideoDevice> videoDevice_;
  winrt::com_ptr<ID3D11VideoContext> videoContext_;
  winrt::com_ptr<ID3D11VideoContext1> videoContext1_; // null on drivers without it (old color-space API then)
  winrt::com_ptr<ID3D11VideoProcessorEnumerator> enumerator_;
  winrt::com_ptr<ID3D11VideoProcessor> processor_;
  Size processorInput_;
  DXGI_FORMAT processorFormat_ = DXGI_FORMAT_UNKNOWN;
  DXGI_FORMAT processorOutputFormat_ = DXGI_FORMAT_UNKNOWN;
  ScalerKind detailScaler_;
  std::unique_ptr<ComputeScaler> compute_;
  // Views hold a reference to their texture, so a cached pointer can't be reused by a new texture.
  std::map<ID3D11Texture2D*, winrt::com_ptr<ID3D11VideoProcessorInputView>> inputViews_;
  std::map<std::pair<ID3D11Texture2D*, UINT>, winrt::com_ptr<ID3D11VideoProcessorOutputView>> outputViews_;
};

} // namespace nexo
