#pragma once
// The one D3D11 device the helper captures, converts and encodes on (SPEC-BETA §4.3).

#include <d3d11_4.h>
#include <dxgi1_6.h>
#include <mfapi.h>
#include <mfidl.h>
#include <winrt/base.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

#include <memory>
#include <string>
#include <vector>

namespace nexo {

struct AdapterDesc {
  LUID luid{};
  std::string name;
  uint32_t vendorId = 0;
  uint32_t deviceId = 0;
  uint64_t dedicatedVideoMemory = 0;
};

/// Hardware adapters, high-performance GPU first (IDXGIFactory6::EnumAdapterByGpuPreference). Software
/// adapters (WARP, Basic Render Driver) are skipped: they have no hardware encoder.
std::vector<AdapterDesc> listAdapters();

/// "0x<High:8 hex><Low:8 hex>": stable within a boot, matches MFT_ENUM_ADAPTER_LUID.
std::string luidToString(LUID luid);
bool sameLuid(LUID a, LUID b);
std::string vendorName(uint32_t pciVendorId);

class D3DDevice {
  struct Private {
    explicit Private() = default;
  };

 public:
  /// Use create(); the tag keeps the constructor callable by make_shared only.
  explicit D3DDevice(Private) {}

  /// Creates a BGRA + video capable device on the adapter with `luid`, multithread-protected (the WGC
  /// callback, the encode thread and the MFT all use it), plus the DXGI device manager the MFT shares.
  static std::shared_ptr<D3DDevice> create(const AdapterDesc& adapter);

  ID3D11Device* device() const { return device_.get(); }
  ID3D11DeviceContext* context() const { return context_.get(); }
  IMFDXGIDeviceManager* dxgiManager() const { return manager_.get(); }
  const winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice& winrtDevice() const { return winrtDevice_; }
  const AdapterDesc& adapter() const { return adapter_; }

  /// S_OK while the device is usable; DXGI_ERROR_DEVICE_REMOVED/RESET/HUNG… after a TDR or driver update.
  HRESULT removedReason() const { return device_->GetDeviceRemovedReason(); }

 private:
  void applyPriorityLevers();

  AdapterDesc adapter_;
  winrt::com_ptr<ID3D11Device> device_;
  winrt::com_ptr<ID3D11DeviceContext> context_;
  winrt::com_ptr<IMFDXGIDeviceManager> manager_;
  UINT managerToken_ = 0;
  winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice winrtDevice_{nullptr};
};

/// Process-wide priority levers that don't need a device (SPEC-BETA §4.3, off unless the env flag is set).
void applyProcessPriorityLevers();

} // namespace nexo
