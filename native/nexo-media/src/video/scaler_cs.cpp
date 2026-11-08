#include "video/scaler_cs.hpp"

#include <d3dcompiler.h>

#include <cmath>
#include <cstring>

#include "common/log.hpp"
#include "common/win_error.hpp"

namespace nexo {
namespace {

// One shader, two entry points. Each pass resamples one axis: output pixel x maps to source coordinate
// u = (x + 0.5) * scale - 0.5; every source pixel within `2 * max(scale, 1)` contributes with the kernel weight
// at (i - u) / max(scale, 1). Widening the kernel by the ratio turns it into a proper low-pass filter when
// downscaling; at 1:1 Catmull-Rom and Lanczos are exact identities. Weights are normalized (edges clamp).
const char* kShader = R"(
cbuffer Params : register(b0) {
  uint2 srcSize;
  uint2 dstSize;
  uint2 dstOffset;
  float scale;
  uint kernelKind; // 0 = Catmull-Rom bicubic, 1 = Lanczos-2
};
Texture2D<float4> src : register(t0);
RWTexture2D<float4> dst : register(u0);

float weight(float x) {
  x = abs(x);
  if (kernelKind == 0) {
    if (x < 1) return (1.5 * x - 2.5) * x * x + 1;
    if (x < 2) return ((-0.5 * x + 2.5) * x - 4) * x + 2;
    return 0;
  }
  if (x < 1e-5) return 1;
  if (x >= 2) return 0;
  float px = 3.14159265 * x;
  return 2 * sin(px) * sin(px * 0.5) / (px * px);
}

float4 resample(uint along, uint across, uint extent, bool horizontal) {
  float stretch = max(scale, 1.0);
  float center = (along + 0.5) * scale - 0.5;
  float radius = 2 * stretch;
  int first = (int)floor(center - radius) + 1;
  int last = (int)floor(center + radius);
  float4 sum = 0;
  float wsum = 0;
  [loop] for (int i = first; i <= last; ++i) {
    float w = weight((i - center) / stretch);
    uint p = (uint)clamp(i, 0, (int)extent - 1);
    sum += w * (horizontal ? src[uint2(p, across)] : src[uint2(across, p)]);
    wsum += w;
  }
  return sum / wsum;
}

[numthreads(8, 8, 1)]
void horizontal(uint3 id : SV_DispatchThreadID) {
  if (any(id.xy >= dstSize)) return;
  dst[id.xy + dstOffset] = resample(id.x, id.y, srcSize.x, true);
}

[numthreads(8, 8, 1)]
void vertical(uint3 id : SV_DispatchThreadID) {
  if (any(id.xy >= dstSize)) return;
  float4 c = resample(id.y, id.x, srcSize.y, false);
  // The negative lobes overshoot at edges (that is the sharpening); clamp, and make it opaque.
  dst[id.xy + dstOffset] = float4(saturate(c.rgb), 1);
}
)";

struct Params {
  uint32_t srcSize[2];
  uint32_t dstSize[2];
  uint32_t dstOffset[2];
  float scale;
  uint32_t kernelKind;
};
static_assert(sizeof(Params) == 32, "constant buffer layout");

winrt::com_ptr<ID3D11ComputeShader> compile(ID3D11Device* device, const char* entry) {
  winrt::com_ptr<ID3DBlob> code;
  winrt::com_ptr<ID3DBlob> errors;
  const HRESULT hr = D3DCompile(kShader, std::strlen(kShader), "scaler_cs", nullptr, nullptr, entry, "cs_5_0",
                                D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, code.put(), errors.put());
  if (FAILED(hr)) {
    throw HrError(hr, std::string("compile scaler ") + entry + ": " +
                          (errors ? static_cast<const char*>(errors->GetBufferPointer()) : ""));
  }
  winrt::com_ptr<ID3D11ComputeShader> shader;
  check(device->CreateComputeShader(code->GetBufferPointer(), code->GetBufferSize(), nullptr, shader.put()), "CreateComputeShader");
  return shader;
}

UINT groups(uint32_t n) {
  return (n + 7) / 8;
}

} // namespace

ScalerKind scalerFromEnv() {
  const auto v = envString("NEXO_MEDIA_SCALER");
  if (v == "bicubic") return ScalerKind::Bicubic;
  if (v == "lanczos") return ScalerKind::Lanczos;
  return ScalerKind::VideoProcessor;
}

std::string_view toString(ScalerKind kind) {
  switch (kind) {
    case ScalerKind::Bicubic: return "bicubic";
    case ScalerKind::Lanczos: return "lanczos";
    case ScalerKind::VideoProcessor: break;
  }
  return "vp";
}

ComputeScaler::ComputeScaler(std::shared_ptr<D3DDevice> device, ScalerKind kind) : device_(std::move(device)), kind_(kind) {
  auto* d = device_->device();
  horizontal_ = compile(d, "horizontal");
  vertical_ = compile(d, "vertical");
  D3D11_BUFFER_DESC bd{};
  bd.ByteWidth = sizeof(Params);
  bd.Usage = D3D11_USAGE_DYNAMIC;
  bd.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
  bd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
  check(d->CreateBuffer(&bd, nullptr, params_.put()), "CreateBuffer (scaler params)");
}

void ComputeScaler::ensureTextures(Size output, Size intermediate) {
  auto* d = device_->device();
  auto make = [&](Size size, DXGI_FORMAT format, UINT bind, winrt::com_ptr<ID3D11Texture2D>& tex) {
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = size.width;
    desc.Height = size.height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = format;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = bind;
    tex = nullptr;
    check(d->CreateTexture2D(&desc, nullptr, tex.put()), "CreateTexture2D (scaler)");
  };
  if (!(intermediateSize_ == intermediate) || !intermediate_) {
    make(intermediate, DXGI_FORMAT_R16G16B16A16_FLOAT, D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_UNORDERED_ACCESS, intermediate_);
    intermediateSrv_ = nullptr;
    intermediateUav_ = nullptr;
    check(d->CreateShaderResourceView(intermediate_.get(), nullptr, intermediateSrv_.put()), "CreateShaderResourceView (scaler)");
    check(d->CreateUnorderedAccessView(intermediate_.get(), nullptr, intermediateUav_.put()), "CreateUnorderedAccessView (scaler)");
    intermediateSize_ = intermediate;
  }
  if (!(targetSize_ == output) || !target_) {
    // RGBA8 rather than BGRA8: typed UAV stores to BGRA are optional on D3D11 hardware, RGBA8 is guaranteed.
    // RENDER_TARGET + SHADER_RESOURCE: what the video processor wants on its input.
    make(output, DXGI_FORMAT_R8G8B8A8_UNORM,
         D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_UNORDERED_ACCESS | D3D11_BIND_RENDER_TARGET, target_);
    targetUav_ = nullptr;
    check(d->CreateUnorderedAccessView(target_.get(), nullptr, targetUav_.put()), "CreateUnorderedAccessView (scaler target)");
    targetSize_ = output;
  }
}

ID3D11ShaderResourceView* ComputeScaler::sourceView(ID3D11Texture2D* src) {
  auto it = sourceViews_.find(src);
  if (it != sourceViews_.end()) return it->second.get();
  if (sourceViews_.size() > 8) sourceViews_.clear(); // ring textures were recreated (resize)
  winrt::com_ptr<ID3D11ShaderResourceView> view;
  check(device_->device()->CreateShaderResourceView(src, nullptr, view.put()), "CreateShaderResourceView (scaler source)");
  return sourceViews_.emplace(src, std::move(view)).first->second.get();
}

void ComputeScaler::scale(ID3D11Texture2D* src, Size content, Size output, const Rect& box) {
  const Size scaled{static_cast<uint32_t>(box.width()), static_cast<uint32_t>(box.height())};
  ensureTextures(output, {scaled.width, content.height});
  auto* srv = sourceView(src);
  auto* ctx = device_->context();

  // The immediate context is shared with the capture callback and the MFT. Each call is individually
  // protected, but the bind-dispatch-unbind sequence must not interleave with another thread's state changes.
  winrt::com_ptr<ID3D10Multithread> multithread;
  check(device_->device()->QueryInterface(IID_PPV_ARGS(multithread.put())), "ID3D10Multithread");
  struct Guard {
    ID3D10Multithread* mt;
    explicit Guard(ID3D10Multithread* m) : mt(m) { mt->Enter(); }
    ~Guard() { mt->Leave(); }
    Guard(const Guard&) = delete;
    Guard& operator=(const Guard&) = delete;
  } guard(multithread.get());

  auto setParams = [&](Size from, Size to, uint32_t ox, uint32_t oy, float ratio) {
    D3D11_MAPPED_SUBRESOURCE mapped{};
    check(ctx->Map(params_.get(), 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped), "Map (scaler params)");
    *static_cast<Params*>(mapped.pData) = Params{{from.width, from.height}, {to.width, to.height}, {ox, oy}, ratio,
                                                 kind_ == ScalerKind::Lanczos ? 1u : 0u};
    ctx->Unmap(params_.get(), 0);
  };
  ID3D11Buffer* cbs[] = {params_.get()};
  ID3D11ShaderResourceView* noSrv[] = {nullptr};
  ID3D11UnorderedAccessView* noUav[] = {nullptr};

  try {
    // Black letterbox bars (and no stale pixels after a resize moved the box).
    const float black[4] = {0, 0, 0, 1};
    ctx->ClearUnorderedAccessViewFloat(targetUav_.get(), black);

    // Pass 1: rows, content.w → box.w.
    setParams(content, {scaled.width, content.height}, 0, 0, static_cast<float>(content.width) / static_cast<float>(scaled.width));
    ctx->CSSetShader(horizontal_.get(), nullptr, 0);
    ctx->CSSetConstantBuffers(0, 1, cbs);
    ID3D11ShaderResourceView* srcs[] = {srv};
    ctx->CSSetShaderResources(0, 1, srcs);
    ID3D11UnorderedAccessView* uavs[] = {intermediateUav_.get()};
    ctx->CSSetUnorderedAccessViews(0, 1, uavs, nullptr);
    ctx->Dispatch(groups(scaled.width), groups(content.height), 1);
    ctx->CSSetUnorderedAccessViews(0, 1, noUav, nullptr);

    // Pass 2: columns, content.h → box.h, written at the box's offset in the target.
    setParams({scaled.width, content.height}, scaled, static_cast<uint32_t>(box.left), static_cast<uint32_t>(box.top),
              static_cast<float>(content.height) / static_cast<float>(scaled.height));
    ctx->CSSetShader(vertical_.get(), nullptr, 0);
    ID3D11ShaderResourceView* mids[] = {intermediateSrv_.get()};
    ctx->CSSetShaderResources(0, 1, mids);
    ID3D11UnorderedAccessView* outs[] = {targetUav_.get()};
    ctx->CSSetUnorderedAccessViews(0, 1, outs, nullptr);
    ctx->Dispatch(groups(scaled.width), groups(scaled.height), 1);
  } catch (...) {
    ctx->CSSetShaderResources(0, 1, noSrv);
    ctx->CSSetUnorderedAccessViews(0, 1, noUav, nullptr);
    throw;
  }
  // Unbind, so the target can be read by the video processor and the source returned to the ring.
  ctx->CSSetShaderResources(0, 1, noSrv);
  ctx->CSSetUnorderedAccessViews(0, 1, noUav, nullptr);
  ctx->CSSetShader(nullptr, nullptr, 0);
}

} // namespace nexo
