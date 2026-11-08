#include "video/convert.hpp"

#include <format>

#include "common/log.hpp"
#include "common/win_error.hpp"

namespace nexo {

VideoConverter::VideoConverter(std::shared_ptr<D3DDevice> device, Size output, bool quality, ScalerKind detailScaler)
    : device_(std::move(device)), output_(output), quality_(quality), detailScaler_(detailScaler) {
  check(device_->device()->QueryInterface(IID_PPV_ARGS(videoDevice_.put())), "ID3D11VideoDevice");
  check(device_->context()->QueryInterface(IID_PPV_ARGS(videoContext_.put())), "ID3D11VideoContext");
  videoContext_.try_as(videoContext1_);
}

void VideoConverter::setDetail(bool detail) {
  if (detail == quality_) return;
  quality_ = detail;
  processor_ = nullptr; // ensureProcessor() recreates it with the other usage
  log::info("convert: {} scaling ({})", detail ? "quality (detail)" : "normal (motion)", toString(activeScaler()));
}

void VideoConverter::ensureProcessor(Size input, DXGI_FORMAT format, DXGI_FORMAT outputFormat) {
  if (processor_ && processorInput_ == input && processorFormat_ == format && processorOutputFormat_ == outputFormat) return;
  processor_ = nullptr;
  enumerator_ = nullptr;
  inputViews_.clear();
  outputViews_.clear();

  D3D11_VIDEO_PROCESSOR_CONTENT_DESC desc{};
  desc.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
  desc.InputWidth = input.width;
  desc.InputHeight = input.height;
  desc.OutputWidth = output_.width;
  desc.OutputHeight = output_.height;
  desc.InputFrameRate = {60, 1};
  desc.OutputFrameRate = {60, 1};
  desc.Usage = quality_ ? D3D11_VIDEO_USAGE_OPTIMAL_QUALITY : D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
  check(videoDevice_->CreateVideoProcessorEnumerator(&desc, enumerator_.put()), "CreateVideoProcessorEnumerator");

  UINT flags = 0;
  check(enumerator_->CheckVideoProcessorFormat(format, &flags), "CheckVideoProcessorFormat(input)");
  if (!(flags & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT)) {
    throw HrError(E_NOTIMPL, std::format("video processor: input format {} unsupported", static_cast<int>(format)));
  }
  check(enumerator_->CheckVideoProcessorFormat(outputFormat, &flags), "CheckVideoProcessorFormat(output)");
  if (!(flags & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT)) {
    throw HrError(E_NOTIMPL, std::format("video processor: output format {} unsupported", static_cast<int>(outputFormat)));
  }
  const bool rgbOut = outputFormat != DXGI_FORMAT_NV12;

  check(videoDevice_->CreateVideoProcessor(enumerator_.get(), 0, processor_.put()), "CreateVideoProcessor");
  processorInput_ = input;
  processorFormat_ = format;
  processorOutputFormat_ = outputFormat;

  auto* ctx = videoContext_.get();
  auto* vp = processor_.get();
  ctx->VideoProcessorSetStreamFrameFormat(vp, 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
  ctx->VideoProcessorSetStreamOutputRate(vp, 0, D3D11_VIDEO_PROCESSOR_OUTPUT_RATE_NORMAL, FALSE, nullptr);
  // No driver "enhancements" (denoise, edge enhancement…): they smear text and cost GPU time.
  ctx->VideoProcessorSetStreamAutoProcessingMode(vp, 0, FALSE);

  // Capture is full-range sRGB; the encoder input is BT.709 limited range, which is also what the SPS VUI says.
  // RGB output (an encoder taking RGB) stays full-range sRGB: the encoder does the YUV conversion.
  if (videoContext1_) {
    videoContext1_->VideoProcessorSetStreamColorSpace1(vp, 0, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
    videoContext1_->VideoProcessorSetOutputColorSpace1(
        vp, rgbOut ? DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709 : DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709);
  } else {
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE in{};
    in.RGB_Range = 0; // full
    in.YCbCr_Matrix = 1;
    ctx->VideoProcessorSetStreamColorSpace(vp, 0, &in);
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE out{};
    out.RGB_Range = 0;
    out.YCbCr_Matrix = 1; // BT.709
    out.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;
    ctx->VideoProcessorSetOutputColorSpace(vp, &out);
  }
  // Letterbox bars: black (limited-range YCbCr: Y 16, Cb/Cr 128).
  D3D11_VIDEO_COLOR black{};
  if (rgbOut) {
    black.RGBA = {0.0f, 0.0f, 0.0f, 1.0f};
  } else {
    black.YCbCr = {16.0f / 255.0f, 0.5f, 0.5f, 1.0f};
  }
  ctx->VideoProcessorSetOutputBackgroundColor(vp, rgbOut ? FALSE : TRUE, &black);
  const RECT target{0, 0, static_cast<LONG>(output_.width), static_cast<LONG>(output_.height)};
  ctx->VideoProcessorSetOutputTargetRect(vp, TRUE, &target);
  log::debug("convert: video processor {}x{} -> {}x{} {}", input.width, input.height, output_.width, output_.height,
             rgbOut ? "BGRA" : "NV12");
}

ID3D11VideoProcessorInputView* VideoConverter::inputView(ID3D11Texture2D* src) {
  auto it = inputViews_.find(src);
  if (it != inputViews_.end()) return it->second.get();
  if (inputViews_.size() > 8) inputViews_.clear(); // ring textures were recreated (resize); drop stale views
  D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC desc{};
  desc.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
  winrt::com_ptr<ID3D11VideoProcessorInputView> view;
  check(videoDevice_->CreateVideoProcessorInputView(src, enumerator_.get(), &desc, view.put()), "CreateVideoProcessorInputView");
  return inputViews_.emplace(src, std::move(view)).first->second.get();
}

ID3D11VideoProcessorOutputView* VideoConverter::outputView(ID3D11Texture2D* dst, UINT slice) {
  const auto key = std::make_pair(dst, slice);
  auto it = outputViews_.find(key);
  if (it != outputViews_.end()) return it->second.get();
  if (outputViews_.size() > 32) outputViews_.clear();
  D3D11_TEXTURE2D_DESC td{};
  dst->GetDesc(&td);
  D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC desc{};
  if (td.ArraySize > 1) {
    // The MF sample allocator may hand out slices of a texture array.
    desc.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2DARRAY;
    desc.Texture2DArray.FirstArraySlice = slice;
    desc.Texture2DArray.ArraySize = 1;
  } else {
    desc.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
  }
  winrt::com_ptr<ID3D11VideoProcessorOutputView> view;
  check(videoDevice_->CreateVideoProcessorOutputView(dst, enumerator_.get(), &desc, view.put()), "CreateVideoProcessorOutputView");
  return outputViews_.emplace(key, std::move(view)).first->second.get();
}

void VideoConverter::convert(ID3D11Texture2D* src, Size content, ID3D11Texture2D* dst, UINT dstSlice) {
  D3D11_TEXTURE2D_DESC dd{};
  dst->GetDesc(&dd);
  const DXGI_FORMAT outFormat = dd.Format;
  const auto box = letterboxRect(content, output_);
  const bool scaling = static_cast<uint32_t>(box.width()) != content.width || static_cast<uint32_t>(box.height()) != content.height;
  if (scaling && quality_ && detailScaler_ != ScalerKind::VideoProcessor) {
    try {
      if (!compute_) compute_ = std::make_unique<ComputeScaler>(device_, detailScaler_);
      compute_->scale(src, content, output_, box);
      // The frame is now letterboxed at the output size: the video processor only converts, 1:1.
      ensureProcessor(output_, DXGI_FORMAT_R8G8B8A8_UNORM, outFormat);
      src = compute_->target();
      content = output_;
    } catch (const std::exception& e) {
      // Never lose the share over the experimental scaler: fall back to the video processor for good.
      log::warn("convert: {} scaler unavailable, using the video processor: {}", toString(detailScaler_), e.what());
      detailScaler_ = ScalerKind::VideoProcessor;
      compute_.reset();
      processor_ = nullptr;
      return convert(src, content, dst, dstSlice);
    }
  } else {
    D3D11_TEXTURE2D_DESC sd{};
    src->GetDesc(&sd);
    ensureProcessor({sd.Width, sd.Height}, sd.Format, outFormat);
  }

  auto* ctx = videoContext_.get();
  auto* vp = processor_.get();
  const RECT source{0, 0, static_cast<LONG>(content.width), static_cast<LONG>(content.height)};
  ctx->VideoProcessorSetStreamSourceRect(vp, 0, TRUE, &source);
  const RECT dest = src == (compute_ ? compute_->target() : nullptr)
                        ? RECT{0, 0, static_cast<LONG>(output_.width), static_cast<LONG>(output_.height)}
                        : RECT{box.left, box.top, box.right, box.bottom};
  ctx->VideoProcessorSetStreamDestRect(vp, 0, TRUE, &dest);

  D3D11_VIDEO_PROCESSOR_STREAM stream{};
  stream.Enable = TRUE;
  stream.pInputSurface = inputView(src);
  check(ctx->VideoProcessorBlt(vp, outputView(dst, dstSlice), 0, 1, &stream), "VideoProcessorBlt");
}

} // namespace nexo
