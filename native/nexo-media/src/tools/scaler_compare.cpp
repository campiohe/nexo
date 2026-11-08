#include "tools/scaler_compare.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <format>

#include <nlohmann/json.hpp>

#include "capture/frame_ring.hpp"
#include "capture/wgc.hpp"
#include "common/log.hpp"
#include "common/wic.hpp"
#include "common/win_error.hpp"
#include "d3d/device.hpp"
#include "video/convert.hpp"
#include "video/scaler_cs.hpp"

namespace nexo {
namespace {

winrt::com_ptr<ID3D11Texture2D> makeTexture(ID3D11Device* d, Size size, DXGI_FORMAT format, UINT bind, D3D11_USAGE usage,
                                            UINT cpu, const void* initial = nullptr, UINT pitch = 0) {
  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = size.width;
  desc.Height = size.height;
  desc.MipLevels = 1;
  desc.ArraySize = 1;
  desc.Format = format;
  desc.SampleDesc.Count = 1;
  desc.Usage = usage;
  desc.BindFlags = bind;
  desc.CPUAccessFlags = cpu;
  D3D11_SUBRESOURCE_DATA data{initial, pitch, 0};
  winrt::com_ptr<ID3D11Texture2D> tex;
  check(d->CreateTexture2D(&desc, initial ? &data : nullptr, tex.put()), "CreateTexture2D");
  return tex;
}

BgraImage readBgra(D3DDevice& dev, ID3D11Texture2D* tex, Size size) {
  auto staging = makeTexture(dev.device(), size, DXGI_FORMAT_B8G8R8A8_UNORM, 0, D3D11_USAGE_STAGING, D3D11_CPU_ACCESS_READ);
  const D3D11_BOX box{0, 0, 0, size.width, size.height, 1};
  dev.context()->CopySubresourceRegion(staging.get(), 0, 0, 0, 0, tex, 0, &box);
  D3D11_MAPPED_SUBRESOURCE m{};
  check(dev.context()->Map(staging.get(), 0, D3D11_MAP_READ, 0, &m), "Map (BGRA readback)");
  BgraImage img{size.width, size.height, std::vector<uint8_t>(static_cast<size_t>(size.width) * size.height * 4)};
  for (uint32_t y = 0; y < size.height; ++y) {
    std::memcpy(&img.pixels[static_cast<size_t>(y) * size.width * 4], static_cast<const uint8_t*>(m.pData) + static_cast<size_t>(y) * m.RowPitch,
                static_cast<size_t>(size.width) * 4);
  }
  dev.context()->Unmap(staging.get(), 0);
  return img;
}

/// NV12 (BT.709 limited range, what the encoder gets) back to RGB, chroma nearest-neighbour. The same for every
/// scaler, so differences in the PNGs come from the scaling alone.
BgraImage readNv12(D3DDevice& dev, ID3D11Texture2D* tex, Size size) {
  auto staging = makeTexture(dev.device(), size, DXGI_FORMAT_NV12, 0, D3D11_USAGE_STAGING, D3D11_CPU_ACCESS_READ);
  dev.context()->CopyResource(staging.get(), tex);
  D3D11_MAPPED_SUBRESOURCE m{};
  check(dev.context()->Map(staging.get(), 0, D3D11_MAP_READ, 0, &m), "Map (NV12 readback)");
  const auto* luma = static_cast<const uint8_t*>(m.pData);
  const auto* chroma = luma + static_cast<size_t>(m.RowPitch) * size.height;
  BgraImage img{size.width, size.height, std::vector<uint8_t>(static_cast<size_t>(size.width) * size.height * 4)};
  auto clamp8 = [](double v) { return static_cast<uint8_t>(std::clamp(v + 0.5, 0.0, 255.0)); };
  for (uint32_t y = 0; y < size.height; ++y) {
    for (uint32_t x = 0; x < size.width; ++x) {
      const double Y = (luma[static_cast<size_t>(y) * m.RowPitch + x] - 16.0) * 255.0 / 219.0;
      const uint8_t* uv = chroma + static_cast<size_t>(y / 2) * m.RowPitch + (x / 2) * 2;
      const double cb = (uv[0] - 128.0) * 255.0 / 224.0;
      const double cr = (uv[1] - 128.0) * 255.0 / 224.0;
      uint8_t* p = &img.pixels[(static_cast<size_t>(y) * size.width + x) * 4];
      p[0] = clamp8(Y + 1.8556 * cb);
      p[1] = clamp8(Y - 0.1873 * cb - 0.4681 * cr);
      p[2] = clamp8(Y + 1.5748 * cr);
      p[3] = 255;
    }
  }
  dev.context()->Unmap(staging.get(), 0);
  return img;
}

BgraImage cropZoom(const BgraImage& src, Rect r, uint32_t zoom) {
  r.left = std::clamp(r.left, 0, static_cast<int32_t>(src.width) - 1);
  r.top = std::clamp(r.top, 0, static_cast<int32_t>(src.height) - 1);
  r.right = std::clamp(r.right, r.left + 1, static_cast<int32_t>(src.width));
  r.bottom = std::clamp(r.bottom, r.top + 1, static_cast<int32_t>(src.height));
  BgraImage out{static_cast<uint32_t>(r.width()) * zoom, static_cast<uint32_t>(r.height()) * zoom, {}};
  out.pixels.resize(static_cast<size_t>(out.width) * out.height * 4);
  for (uint32_t y = 0; y < out.height; ++y) {
    for (uint32_t x = 0; x < out.width; ++x) {
      const size_t s = (static_cast<size_t>(r.top + static_cast<int32_t>(y / zoom)) * src.width + r.left + x / zoom) * 4;
      std::memcpy(&out.pixels[(static_cast<size_t>(y) * out.width + x) * 4], &src.pixels[s], 4);
    }
  }
  return out;
}

void report(const std::filesystem::path& file, Size size, std::string_view what) {
  EventSink::instance().write(
      nlohmann::json{{"type", "png"}, {"file", file.string()}, {"width", size.width}, {"height", size.height}, {"what", what}}.dump());
}

} // namespace

int runScalerCompare(const ScalerCompareOptions& o) {
  const auto adapters = listAdapters();
  if (adapters.empty()) throw std::runtime_error("no hardware GPU adapter");
  auto device = D3DDevice::create(adapters.front());
  std::filesystem::create_directories(o.outDir);

  // The source frame, in a texture we own.
  winrt::com_ptr<ID3D11Texture2D> source;
  Size size;
  if (o.image) {
    auto img = loadImage(*o.image);
    size = {img.width, img.height};
    source = makeTexture(device->device(), size, DXGI_FORMAT_B8G8R8A8_UNORM, D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET,
                         D3D11_USAGE_DEFAULT, 0, img.pixels.data(), img.width * 4);
  } else {
    winrt::com_ptr<ID3D11Device> d3d;
    d3d.copy_from(device->device());
    FrameRing ring(std::move(d3d));
    WgcCapture capture(device, ring, WgcCapture::Target{nullptr, o.monitor}, false, 60);
    capture.start();
    if (WaitForSingleObject(ring.frameEvent(), 3000) != WAIT_OBJECT_0) throw std::runtime_error("no frame from the monitor within 3 s");
    auto frame = ring.acquire();
    size = frame->size;
    source = makeTexture(device->device(), size, DXGI_FORMAT_B8G8R8A8_UNORM, D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET,
                         D3D11_USAGE_DEFAULT, 0);
    const D3D11_BOX box{0, 0, 0, size.width, size.height, 1};
    device->context()->CopySubresourceRegion(source.get(), 0, 0, 0, 0, frame->texture, 0, &box);
    ring.release(*frame);
    capture.stop();
  }
  const auto sourceImage = readBgra(*device, source.get(), size);
  savePng(o.outDir / "source.png", sourceImage);
  report(o.outDir / "source.png", size, "source");

  for (const Size box : o.boxes) {
    const Size output = pickOutputSize(size, box);
    if (o.crop) {
      // The same region of the source, enlarged so it lines up with the scaled crops.
      const double ratio = static_cast<double>(size.width) / output.width;
      const Rect r{static_cast<int32_t>(o.crop->left * ratio), static_cast<int32_t>(o.crop->top * ratio),
                   static_cast<int32_t>(o.crop->right * ratio), static_cast<int32_t>(o.crop->bottom * ratio)};
      const auto zoom = std::max<uint32_t>(1, static_cast<uint32_t>(std::lround(o.zoom / ratio)));
      const auto file = o.outDir / std::format("{}x{}-source-crop.png", output.width, output.height);
      savePng(file, cropZoom(sourceImage, r, zoom));
      report(file, size, "source crop");
    }
    for (const ScalerKind kind : {ScalerKind::VideoProcessor, ScalerKind::Bicubic, ScalerKind::Lanczos}) {
      VideoConverter converter(device, output, true, kind);
      auto nv12 = makeTexture(device->device(), output, DXGI_FORMAT_NV12, D3D11_BIND_RENDER_TARGET, D3D11_USAGE_DEFAULT, 0);
      converter.convert(source.get(), size, nv12.get(), 0);
      const auto image = readNv12(*device, nv12.get(), output);
      const auto name = std::format("{}x{}-{}", output.width, output.height, toString(converter.activeScaler()));
      savePng(o.outDir / (name + ".png"), image);
      report(o.outDir / (name + ".png"), output, toString(kind));
      if (o.crop) {
        savePng(o.outDir / (name + "-crop.png"), cropZoom(image, *o.crop, o.zoom));
        report(o.outDir / (name + "-crop.png"), output, "crop");
      }
    }
  }
  return 0;
}

} // namespace nexo
