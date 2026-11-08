#include "capture/frame_ring.hpp"

#include <windows.h>

#include "common/log.hpp"
#include "common/win_error.hpp"

namespace nexo {

int64_t qpcMicros() {
  static const int64_t freq = [] {
    LARGE_INTEGER f;
    QueryPerformanceFrequency(&f);
    return f.QuadPart;
  }();
  LARGE_INTEGER now;
  QueryPerformanceCounter(&now);
  return static_cast<int64_t>(static_cast<double>(now.QuadPart) * 1'000'000.0 / static_cast<double>(freq));
}

FrameRing::FrameRing(winrt::com_ptr<ID3D11Device> device)
    : device_(std::move(device)), frameEvent_(CreateEventW(nullptr, FALSE, FALSE, nullptr)) {
  if (!frameEvent_) throw HrError(HRESULT_FROM_WIN32(GetLastError()), "CreateEvent (frame ring)");
}

bool FrameRing::ensureTexture(Slot& slot, Size size, DXGI_FORMAT format) {
  if (slot.texture && slot.textureSize == size) return true;
  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = size.width;
  desc.Height = size.height;
  desc.MipLevels = 1;
  desc.ArraySize = 1;
  desc.Format = format;
  desc.SampleDesc.Count = 1;
  desc.Usage = D3D11_USAGE_DEFAULT;
  // Input of ID3D11VideoProcessor (an input view needs one of these bind flags on most drivers).
  desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
  slot.texture = nullptr;
  const HRESULT hr = device_->CreateTexture2D(&desc, nullptr, slot.texture.put());
  if (FAILED(hr)) {
    log::error("frame ring: CreateTexture2D {}x{} failed: {}", size.width, size.height, describeHresult(hr));
    return false;
  }
  slot.textureSize = size;
  return true;
}

bool FrameRing::push(ID3D11DeviceContext* context, ID3D11Texture2D* src, Size content, int64_t timestampUs) {
  D3D11_TEXTURE2D_DESC srcDesc{};
  src->GetDesc(&srcDesc);
  content.width = std::min(content.width, srcDesc.Width);
  content.height = std::min(content.height, srcDesc.Height);
  if (content.width < 2 || content.height < 2) return false;

  std::unique_lock lock(mutex_);
  int target = -1;
  // Oldest slot that is neither the latest nor leased.
  for (int i = 0; i < kSlots; ++i) {
    if (i == latest_ || i == leased_) continue;
    if (target < 0 || slots_[i].seq < slots_[target].seq) target = i;
  }
  if (target < 0) return false;
  Slot& slot = slots_[target];
  // The reader only leases `latest_`, which this slot isn't, and the mutex keeps other writers out.
  if (!ensureTexture(slot, content, srcDesc.Format)) return false;

  // Copy only the content region: the pool buffer can be larger than the content after a resize.
  D3D11_BOX box{0, 0, 0, content.width, content.height, 1};
  context->CopySubresourceRegion(slot.texture.get(), 0, 0, 0, 0, src, 0, &box);
  slot.content = content;
  slot.timestampUs = timestampUs;
  slot.seq = nextSeq_++;
  latest_ = target;
  lock.unlock();

  pushed_.fetch_add(1);
  lastPushUs_.store(qpcMicros());
  SetEvent(frameEvent_.get());
  return true;
}

std::optional<FrameRing::Frame> FrameRing::acquire() {
  std::lock_guard lock(mutex_);
  if (latest_ < 0) return std::nullopt;
  leased_ = latest_;
  const Slot& slot = slots_[leased_];
  return Frame{slot.texture.get(), slot.content, slot.timestampUs, slot.seq};
}

void FrameRing::release() {
  std::lock_guard lock(mutex_);
  leased_ = -1;
}

} // namespace nexo
