#include "capture/frame_ring.hpp"

#include <windows.h>

#include "common/log.hpp"
#include "common/win_error.hpp"

namespace nexo {

namespace {
// Copy mode starts with three textures (one being written, the latest, one leased) and grows only while the
// encoder keeps frames longer than a conversion (RGB input).
constexpr int kInitialSlots = 3;
} // namespace

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
    : device_(std::move(device)), slots_(kInitialSlots), frameEvent_(CreateEventW(nullptr, FALSE, FALSE, nullptr)) {
  if (!frameEvent_) throw HrError(HRESULT_FROM_WIN32(GetLastError()), "CreateEvent (frame ring)");
}

FrameRing::~FrameRing() {
  std::vector<std::function<void()>> giveBacks;
  {
    std::lock_guard lock(mutex_);
    for (auto& slot : slots_) {
      if (slot.giveBack) giveBacks.push_back(std::move(slot.giveBack));
      slot.giveBack = nullptr;
      slot.texture = nullptr;
    }
  }
  for (auto& g : giveBacks) g();
}

bool FrameRing::ensureTexture(Slot& slot, Size size, DXGI_FORMAT format) {
  if (slot.texture && !slot.giveBack && slot.textureSize == size) {
    D3D11_TEXTURE2D_DESC d{};
    slot.texture->GetDesc(&d);
    if (d.Format == format) return true;
  }
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
  slot.giveBack = nullptr;
  const HRESULT hr = device_->CreateTexture2D(&desc, nullptr, slot.texture.put());
  if (FAILED(hr)) {
    log::error("frame ring: CreateTexture2D {}x{} failed: {}", size.width, size.height, describeHresult(hr));
    return false;
  }
  slot.textureSize = size;
  return true;
}

int FrameRing::freeSlot(bool grow) {
  int target = -1;
  for (int i = 0; i < static_cast<int>(slots_.size()); ++i) {
    if (i == latest_ || slots_[i].leases > 0) continue;
    if (target < 0 || slots_[i].seq < slots_[target].seq) target = i;
  }
  if (target < 0 && grow && static_cast<int>(slots_.size()) < kMaxSlots) {
    slots_.emplace_back();
    target = static_cast<int>(slots_.size()) - 1;
  }
  return target;
}

std::function<void()> FrameRing::takeIfUnused(int index) {
  if (index < 0) return nullptr;
  Slot& slot = slots_[index];
  if (!slot.giveBack || slot.leases > 0 || index == latest_) return nullptr;
  auto giveBack = std::move(slot.giveBack);
  slot.giveBack = nullptr;
  slot.texture = nullptr;
  slot.textureSize = {};
  return giveBack;
}

void FrameRing::published() {
  pushed_.fetch_add(1);
  lastPushUs_.store(qpcMicros());
  SetEvent(frameEvent_.get());
}

bool FrameRing::push(ID3D11DeviceContext* context, ID3D11Texture2D* src, Size content, int64_t timestampUs) {
  D3D11_TEXTURE2D_DESC srcDesc{};
  src->GetDesc(&srcDesc);
  content.width = std::min(content.width, srcDesc.Width);
  content.height = std::min(content.height, srcDesc.Height);
  if (content.width < 2 || content.height < 2) return false;

  std::unique_lock lock(mutex_);
  const int target = freeSlot(true);
  if (target < 0) return false;
  Slot& slot = slots_[target];
  // A held buffer here would mean a source mixing both ways in; give it back rather than leak it.
  auto stale = std::move(slot.giveBack);
  slot.giveBack = nullptr;
  // The reader only leases `latest_`, which this slot isn't, and the mutex keeps other writers out.
  if (!ensureTexture(slot, content, srcDesc.Format)) {
    lock.unlock();
    if (stale) stale();
    return false;
  }

  // Copy only the content region: the pool buffer can be larger than the content after a resize.
  D3D11_BOX box{0, 0, 0, content.width, content.height, 1};
  context->CopySubresourceRegion(slot.texture.get(), 0, 0, 0, 0, src, 0, &box);
  slot.content = content;
  slot.timestampUs = timestampUs;
  slot.seq = nextSeq_++;
  latest_ = target;
  lock.unlock();
  if (stale) stale();
  published();
  return true;
}

bool FrameRing::pushHeld(winrt::com_ptr<ID3D11Texture2D> texture, Size content, int64_t timestampUs, std::function<void()> giveBack) {
  D3D11_TEXTURE2D_DESC desc{};
  texture->GetDesc(&desc);
  content.width = std::min(content.width, desc.Width);
  content.height = std::min(content.height, desc.Height);
  if (content.width < 2 || content.height < 2) return false;

  std::function<void()> superseded;
  {
    std::lock_guard lock(mutex_);
    const int target = freeSlot(true);
    if (target < 0) return false;
    Slot& slot = slots_[target];
    slot.texture = std::move(texture);
    slot.textureSize = {desc.Width, desc.Height};
    slot.giveBack = std::move(giveBack);
    slot.content = content;
    slot.timestampUs = timestampUs;
    slot.seq = nextSeq_++;
    const int previous = latest_;
    latest_ = target;
    // The frame this one replaces goes back to DWM now, unless the encoder still uses it.
    superseded = takeIfUnused(previous);
  }
  if (superseded) superseded();
  published();
  return true;
}

std::optional<FrameRing::Frame> FrameRing::acquire() {
  std::lock_guard lock(mutex_);
  if (latest_ < 0) return std::nullopt;
  Slot& slot = slots_[latest_];
  ++slot.leases;
  return Frame{slot.texture.get(), slot.content, slot.timestampUs, slot.seq, latest_, static_cast<bool>(slot.giveBack)};
}

void FrameRing::release(const Frame& frame) {
  std::function<void()> giveBack;
  {
    std::lock_guard lock(mutex_);
    if (frame.slot < 0 || frame.slot >= static_cast<int>(slots_.size())) return;
    Slot& slot = slots_[frame.slot];
    if (slot.leases > 0) --slot.leases;
    giveBack = takeIfUnused(frame.slot);
  }
  if (giveBack) giveBack();
}

int FrameRing::held() const {
  std::lock_guard lock(mutex_);
  int n = 0;
  for (const auto& s : slots_) n += s.giveBack ? 1 : 0;
  return n;
}

} // namespace nexo
