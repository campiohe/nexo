#include "d3d/device.hpp"

#include <windows.graphics.directx.direct3d11.interop.h>

#include <format>

#include "common/log.hpp"
#include "common/win_error.hpp"

namespace nexo {

std::vector<AdapterDesc> listAdapters() {
  winrt::com_ptr<IDXGIFactory6> factory;
  check(CreateDXGIFactory2(0, IID_PPV_ARGS(factory.put())), "CreateDXGIFactory2");
  std::vector<AdapterDesc> out;
  for (UINT i = 0;; ++i) {
    winrt::com_ptr<IDXGIAdapter1> adapter;
    const HRESULT hr = factory->EnumAdapterByGpuPreference(i, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE, IID_PPV_ARGS(adapter.put()));
    if (hr == DXGI_ERROR_NOT_FOUND) break;
    check(hr, "EnumAdapterByGpuPreference");
    DXGI_ADAPTER_DESC1 desc{};
    check(adapter->GetDesc1(&desc), "IDXGIAdapter1::GetDesc1");
    if (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) continue;
    AdapterDesc a;
    a.luid = desc.AdapterLuid;
    a.name = toUtf8(desc.Description);
    a.vendorId = desc.VendorId;
    a.deviceId = desc.DeviceId;
    a.dedicatedVideoMemory = desc.DedicatedVideoMemory;
    out.push_back(std::move(a));
  }
  return out;
}

std::string luidToString(LUID luid) {
  return std::format("0x{:08X}{:08X}", static_cast<uint32_t>(luid.HighPart), luid.LowPart);
}

bool sameLuid(LUID a, LUID b) {
  return a.HighPart == b.HighPart && a.LowPart == b.LowPart;
}

std::string vendorName(uint32_t id) {
  switch (id) {
    case 0x10DE: return "NVIDIA";
    case 0x1002:
    case 0x1022: return "AMD";
    case 0x8086: return "Intel";
    case 0x1414: return "Microsoft";
    case 0x5143: return "Qualcomm";
    default: return std::format("0x{:04X}", id);
  }
}

std::shared_ptr<D3DDevice> D3DDevice::create(const AdapterDesc& wanted) {
  winrt::com_ptr<IDXGIFactory6> factory;
  check(CreateDXGIFactory2(0, IID_PPV_ARGS(factory.put())), "CreateDXGIFactory2");
  winrt::com_ptr<IDXGIAdapter> adapter;
  check(factory->EnumAdapterByLuid(wanted.luid, IID_PPV_ARGS(adapter.put())), "EnumAdapterByLuid");

  auto self = std::make_shared<D3DDevice>(Private{});
  self->adapter_ = wanted;

  // BGRA: WGC frames and Direct2D-style interop. VIDEO_SUPPORT: ID3D11VideoProcessor and the MFT.
  const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
  UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
  if (envFlag("NEXO_MEDIA_D3D_DEBUG")) flags |= D3D11_CREATE_DEVICE_DEBUG;
  check(D3D11CreateDevice(adapter.get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, flags, levels,
                          static_cast<UINT>(std::size(levels)), D3D11_SDK_VERSION, self->device_.put(), nullptr,
                          self->context_.put()),
        "D3D11CreateDevice");

  // The immediate context is used from the WGC callback thread, the encode thread and inside the MFT.
  auto multithread = self->device_.as<ID3D10Multithread>();
  multithread->SetMultithreadProtected(TRUE);

  check(MFCreateDXGIDeviceManager(&self->managerToken_, self->manager_.put()), "MFCreateDXGIDeviceManager");
  check(self->manager_->ResetDevice(self->device_.get(), self->managerToken_), "IMFDXGIDeviceManager::ResetDevice");

  auto dxgiDevice = self->device_.as<IDXGIDevice>();
  winrt::com_ptr<::IInspectable> inspectable;
  check(CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.get(), inspectable.put()), "CreateDirect3D11DeviceFromDXGIDevice");
  self->winrtDevice_ = inspectable.as<winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();

  self->applyPriorityLevers();
  return self;
}

bool priorityLever(PriorityLever lever) {
  const char* name = nullptr;
  bool fallback = false;
  switch (lever) {
    case PriorityLever::GpuThreadPriority: name = "NEXO_MEDIA_GPU_PRIORITY"; fallback = kGpuThreadPriorityDefault; break;
    case PriorityLever::GpuSchedulingHigh: name = "NEXO_MEDIA_GPU_SCHED_HIGH"; fallback = kGpuSchedulingHighDefault; break;
    case PriorityLever::AboveNormal: name = "NEXO_MEDIA_ABOVE_NORMAL"; fallback = kAboveNormalDefault; break;
  }
  const auto v = envString(name);
  return v.empty() ? fallback : envFlag(name);
}

void D3DDevice::applyPriorityLevers() {
  // SPEC-BETA §4.3: raise our GPU thread priority so capture/convert/encode aren't starved by a GPU-bound game.
  if (priorityLever(PriorityLever::GpuThreadPriority)) {
    auto dxgiDevice = device_.as<IDXGIDevice>();
    const HRESULT hr = dxgiDevice->SetGPUThreadPriority(7);
    if (SUCCEEDED(hr)) {
      log::info("GPU thread priority set to 7 (NEXO_MEDIA_GPU_PRIORITY=0 turns it off)");
    } else {
      log::warn("SetGPUThreadPriority(7) failed: {}", describeHresult(hr));
    }
  }
}

void applyProcessPriorityLevers() {
  // D3DKMTSetProcessSchedulingPriorityClass lives in gdi32 and its header ships with the WDK, so it's
  // resolved at runtime. HIGH = 4 in D3DKMT_SCHEDULINGPRIORITYCLASS; REALTIME needs admin (out of scope).
  if (priorityLever(PriorityLever::GpuSchedulingHigh)) {
    using Fn = LONG(APIENTRY*)(HANDLE, int);
    auto fn = reinterpret_cast<Fn>(GetProcAddress(GetModuleHandleW(L"gdi32.dll"), "D3DKMTSetProcessSchedulingPriorityClass"));
    const LONG status = fn ? fn(GetCurrentProcess(), 4) : -1;
    if (status == 0) {
      log::info("GPU scheduling priority class set to HIGH (NEXO_MEDIA_GPU_SCHED_HIGH=0 turns it off)");
    } else {
      log::warn("D3DKMTSetProcessSchedulingPriorityClass(HIGH) failed: NTSTATUS 0x{:08X}", static_cast<uint32_t>(status));
    }
  }
  if (priorityLever(PriorityLever::AboveNormal)) {
    if (SetPriorityClass(GetCurrentProcess(), ABOVE_NORMAL_PRIORITY_CLASS)) {
      log::info("process priority class ABOVE_NORMAL (NEXO_MEDIA_ABOVE_NORMAL=0 turns it off)");
    } else {
      log::warn("SetPriorityClass(ABOVE_NORMAL) failed: {}", describeHresult(HRESULT_FROM_WIN32(GetLastError())));
    }
  }
}

} // namespace nexo
