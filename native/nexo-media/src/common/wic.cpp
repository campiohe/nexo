#include "common/wic.hpp"

#include <windows.h>
#include <wincodec.h>
#include <winrt/base.h>

#include "common/win_error.hpp"

namespace nexo {
namespace {

winrt::com_ptr<IWICImagingFactory> factory() {
  winrt::com_ptr<IWICImagingFactory> f;
  check(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(f.put())), "CoCreateInstance(WIC)");
  return f;
}

} // namespace

void savePng(const std::filesystem::path& path, const BgraImage& image) {
  auto f = factory();
  winrt::com_ptr<IWICStream> stream;
  check(f->CreateStream(stream.put()), "IWICImagingFactory::CreateStream");
  check(stream->InitializeFromFilename(path.c_str(), GENERIC_WRITE), "IWICStream::InitializeFromFilename");
  winrt::com_ptr<IWICBitmapEncoder> encoder;
  check(f->CreateEncoder(GUID_ContainerFormatPng, nullptr, encoder.put()), "CreateEncoder(PNG)");
  check(encoder->Initialize(stream.get(), WICBitmapEncoderNoCache), "IWICBitmapEncoder::Initialize");
  winrt::com_ptr<IWICBitmapFrameEncode> frame;
  check(encoder->CreateNewFrame(frame.put(), nullptr), "CreateNewFrame");
  check(frame->Initialize(nullptr), "IWICBitmapFrameEncode::Initialize");
  check(frame->SetSize(image.width, image.height), "SetSize");
  WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
  check(frame->SetPixelFormat(&format), "SetPixelFormat");
  check(frame->WritePixels(image.height, image.width * 4, static_cast<UINT>(image.pixels.size()),
                           const_cast<BYTE*>(image.pixels.data())),
        "WritePixels");
  check(frame->Commit(), "IWICBitmapFrameEncode::Commit");
  check(encoder->Commit(), "IWICBitmapEncoder::Commit");
}

BgraImage loadImage(const std::filesystem::path& path) {
  auto f = factory();
  winrt::com_ptr<IWICBitmapDecoder> decoder;
  check(f->CreateDecoderFromFilename(path.c_str(), nullptr, GENERIC_READ, WICDecodeMetadataCacheOnDemand, decoder.put()),
        "CreateDecoderFromFilename");
  winrt::com_ptr<IWICBitmapFrameDecode> frame;
  check(decoder->GetFrame(0, frame.put()), "GetFrame");
  winrt::com_ptr<IWICFormatConverter> converter;
  check(f->CreateFormatConverter(converter.put()), "CreateFormatConverter");
  check(converter->Initialize(frame.get(), GUID_WICPixelFormat32bppBGRA, WICBitmapDitherTypeNone, nullptr, 0,
                              WICBitmapPaletteTypeCustom),
        "IWICFormatConverter::Initialize");
  BgraImage image;
  check(converter->GetSize(&image.width, &image.height), "GetSize");
  image.pixels.resize(static_cast<size_t>(image.width) * image.height * 4);
  check(converter->CopyPixels(nullptr, image.width * 4, static_cast<UINT>(image.pixels.size()), image.pixels.data()), "CopyPixels");
  return image;
}

} // namespace nexo
