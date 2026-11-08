#pragma once
// BGRA capture → NV12 encoder input on the GPU with ID3D11VideoProcessor (SPEC-BETA §4.5): scale to the fixed
// output size keeping the aspect ratio (black bars), BT.709 limited range.

#include <d3d11_1.h>
#include <winrt/base.h>

#include <map>
#include <memory>

#include "d3d/device.hpp"
#include "video/output_size.hpp"

namespace nexo {

class VideoConverter {
 public:
  /// `quality`: ask the driver for its best scaler (detail/text) instead of the normal playback one.
  VideoConverter(std::shared_ptr<D3DDevice> device, Size output, bool quality);

  /// Converts the top-left `content` region of `src` into `dst` (NV12, output size, subresource `dstSlice`).
  /// Throws HrError on failure.
  void convert(ID3D11Texture2D* src, Size content, ID3D11Texture2D* dst, UINT dstSlice);

  Size output() const { return output_; }

 private:
  void ensureProcessor(Size input);
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
  // Views hold a reference to their texture, so a cached pointer can't be reused by a new texture.
  std::map<ID3D11Texture2D*, winrt::com_ptr<ID3D11VideoProcessorInputView>> inputViews_;
  std::map<std::pair<ID3D11Texture2D*, UINT>, winrt::com_ptr<ID3D11VideoProcessorOutputView>> outputViews_;
};

} // namespace nexo
