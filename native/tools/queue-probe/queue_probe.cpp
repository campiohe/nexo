// queue-probe.exe: how long a tiny GPU job waits behind a GPU-bound foreground game, per queue kind
// (docs/benchmarks/beta-m3-fps-gap.md, experiment c).
//
// Every 1/60 s it submits one 1920x1080 BGRA CopyResource (what the helper's ring copy is) and measures the time
// from submission to completion (fence event), for each configuration in turn:
//   d3d11            a plain D3D11 device (the helper's)
//   d3d12-direct-normal / -high / -realtime   a D3D12 direct (3D) queue at that priority
//   d3d12-compute-normal / -high              a D3D12 compute queue
//   d3d12-copy-normal / -high                 a D3D12 copy queue (copy engine)
// GLOBAL_REALTIME needs a privilege we don't have: it is expected to fail queue creation and is reported so.
//
//   queue-probe.exe [--seconds 10] [--configs d3d11,d3d12-direct-high,...]
//
// stdout, one JSON object per line: {"type":"result","config":…,"ok":true,"submits":…,"meanMs":…,"p50Ms":…,
// "p95Ms":…,"maxMs":…,"perSecond":…} ("perSecond": jobs completed per second, the job being re-submitted as soon
// as the previous completes or the next 1/60 s tick comes, whichever is later).
#include <windows.h>

#include <d3d11_4.h>
#include <d3d12.h>
#include <dxgi1_6.h>
#include <winrt/base.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cwchar>
#include <string>
#include <thread>
#include <vector>

namespace {

using clock_type = std::chrono::steady_clock;

struct Result {
  bool ok = false;
  std::string error;
  std::vector<double> latenciesMs;
  double seconds = 0;
};

std::string hex(HRESULT hr) {
  char buf[16];
  std::snprintf(buf, sizeof(buf), "0x%08lX", static_cast<unsigned long>(hr));
  return buf;
}

winrt::com_ptr<IDXGIAdapter1> highPerformanceAdapter() {
  winrt::com_ptr<IDXGIFactory6> factory;
  winrt::check_hresult(CreateDXGIFactory2(0, IID_PPV_ARGS(factory.put())));
  winrt::com_ptr<IDXGIAdapter1> adapter;
  winrt::check_hresult(factory->EnumAdapterByGpuPreference(0, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE, IID_PPV_ARGS(adapter.put())));
  return adapter;
}

/// Runs `submit` (which must signal `fence` to the returned value) on a 60 Hz grid for `seconds`.
template <typename Submit>
void measure(Result& r, double seconds, ID3D12Fence* fence12, ID3D11Fence* fence11, Submit submit) {
  winrt::handle event(CreateEventW(nullptr, FALSE, FALSE, nullptr));
  const auto start = clock_type::now();
  auto next = start;
  const auto period = std::chrono::microseconds(16'667);
  while (clock_type::now() - start < std::chrono::duration<double>(seconds)) {
    const auto t0 = clock_type::now();
    const uint64_t value = submit();
    if (fence12) fence12->SetEventOnCompletion(value, event.get());
    if (fence11) fence11->SetEventOnCompletion(value, event.get());
    WaitForSingleObject(event.get(), 5000);
    const auto t1 = clock_type::now();
    r.latenciesMs.push_back(std::chrono::duration<double, std::milli>(t1 - t0).count());
    next += period;
    if (next > t1) std::this_thread::sleep_for(next - t1);
    else next = t1;
  }
  r.seconds = std::chrono::duration<double>(clock_type::now() - start).count();
  r.ok = true;
}

Result runD3D11(double seconds) {
  Result r;
  auto adapter = highPerformanceAdapter();
  winrt::com_ptr<ID3D11Device> device;
  winrt::com_ptr<ID3D11DeviceContext> context;
  const D3D_FEATURE_LEVEL level = D3D_FEATURE_LEVEL_11_1;
  HRESULT hr = D3D11CreateDevice(adapter.get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, &level, 1,
                                 D3D11_SDK_VERSION, device.put(), nullptr, context.put());
  if (FAILED(hr)) return {false, "D3D11CreateDevice " + hex(hr)};
  D3D11_TEXTURE2D_DESC d{};
  d.Width = 1920;
  d.Height = 1080;
  d.MipLevels = 1;
  d.ArraySize = 1;
  d.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  d.SampleDesc.Count = 1;
  d.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
  winrt::com_ptr<ID3D11Texture2D> a, b;
  device->CreateTexture2D(&d, nullptr, a.put());
  device->CreateTexture2D(&d, nullptr, b.put());
  winrt::com_ptr<ID3D11Fence> fence;
  hr = device.as<ID3D11Device5>()->CreateFence(0, D3D11_FENCE_FLAG_NONE, IID_PPV_ARGS(fence.put()));
  if (FAILED(hr)) return {false, "CreateFence " + hex(hr)};
  auto ctx4 = context.as<ID3D11DeviceContext4>();
  uint64_t value = 0;
  measure(r, seconds, nullptr, fence.get(), [&] {
    context->CopyResource(b.get(), a.get());
    ctx4->Signal(fence.get(), ++value);
    context->Flush();
    return value;
  });
  return r;
}

Result runD3D12(double seconds, D3D12_COMMAND_LIST_TYPE type, int priority) {
  Result r;
  auto adapter = highPerformanceAdapter();
  winrt::com_ptr<ID3D12Device> device;
  HRESULT hr = D3D12CreateDevice(adapter.get(), D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(device.put()));
  if (FAILED(hr)) return {false, "D3D12CreateDevice " + hex(hr)};
  D3D12_COMMAND_QUEUE_DESC qd{};
  qd.Type = type;
  qd.Priority = priority;
  winrt::com_ptr<ID3D12CommandQueue> queue;
  hr = device->CreateCommandQueue(&qd, IID_PPV_ARGS(queue.put()));
  if (FAILED(hr)) return {false, "CreateCommandQueue " + hex(hr)};
  D3D12_HEAP_PROPERTIES heap{D3D12_HEAP_TYPE_DEFAULT};
  D3D12_RESOURCE_DESC rd{};
  rd.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
  rd.Width = 1920;
  rd.Height = 1080;
  rd.DepthOrArraySize = 1;
  rd.MipLevels = 1;
  rd.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  rd.SampleDesc.Count = 1;
  winrt::com_ptr<ID3D12Resource> a, b;
  // COMMON: usable by every queue type without a transition (copy queues promote from it).
  hr = device->CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE, &rd, D3D12_RESOURCE_STATE_COMMON, nullptr, IID_PPV_ARGS(a.put()));
  if (SUCCEEDED(hr)) hr = device->CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE, &rd, D3D12_RESOURCE_STATE_COMMON, nullptr, IID_PPV_ARGS(b.put()));
  if (FAILED(hr)) return {false, "CreateCommittedResource " + hex(hr)};
  winrt::com_ptr<ID3D12CommandAllocator> allocator;
  winrt::com_ptr<ID3D12GraphicsCommandList> list;
  winrt::check_hresult(device->CreateCommandAllocator(type, IID_PPV_ARGS(allocator.put())));
  winrt::check_hresult(device->CreateCommandList(0, type, allocator.get(), nullptr, IID_PPV_ARGS(list.put())));
  list->CopyResource(b.get(), a.get());
  winrt::check_hresult(list->Close());
  winrt::com_ptr<ID3D12Fence> fence;
  winrt::check_hresult(device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(fence.put())));
  uint64_t value = 0;
  ID3D12CommandList* lists[] = {list.get()};
  measure(r, seconds, fence.get(), nullptr, [&] {
    queue->ExecuteCommandLists(1, lists); // the same recorded copy each time (it completed before)
    queue->Signal(fence.get(), ++value);
    return value;
  });
  return r;
}

double percentile(std::vector<double> v, double p) {
  if (v.empty()) return 0;
  std::sort(v.begin(), v.end());
  return v[std::min(v.size() - 1, static_cast<size_t>(p * static_cast<double>(v.size())))];
}

double argNumber(int argc, wchar_t** argv, const wchar_t* name, double fallback) {
  for (int i = 1; i + 1 < argc; ++i)
    if (std::wcscmp(argv[i], name) == 0) return _wtof(argv[i + 1]);
  return fallback;
}

std::wstring argString(int argc, wchar_t** argv, const wchar_t* name, const wchar_t* fallback) {
  for (int i = 1; i + 1 < argc; ++i)
    if (std::wcscmp(argv[i], name) == 0) return argv[i + 1];
  return fallback;
}

} // namespace

int wmain(int argc, wchar_t** argv) {
  const double seconds = argNumber(argc, argv, L"--seconds", 10);
  const std::wstring configs = argString(argc, argv, L"--configs",
                                         L"d3d11,d3d12-direct-normal,d3d12-direct-high,d3d12-direct-realtime,d3d12-compute-normal,"
                                         L"d3d12-compute-high,d3d12-copy-normal,d3d12-copy-high");
  size_t pos = 0;
  while (pos <= configs.size()) {
    const size_t comma = std::min(configs.find(L',', pos), configs.size());
    const std::wstring name = configs.substr(pos, comma - pos);
    pos = comma + 1;
    if (name.empty()) continue;
    Result r;
    try {
      if (name == L"d3d11") {
        r = runD3D11(seconds);
      } else {
        D3D12_COMMAND_LIST_TYPE type = D3D12_COMMAND_LIST_TYPE_DIRECT;
        if (name.find(L"compute") != std::wstring::npos) type = D3D12_COMMAND_LIST_TYPE_COMPUTE;
        if (name.find(L"copy") != std::wstring::npos) type = D3D12_COMMAND_LIST_TYPE_COPY;
        int priority = D3D12_COMMAND_QUEUE_PRIORITY_NORMAL;
        if (name.ends_with(L"-high")) priority = D3D12_COMMAND_QUEUE_PRIORITY_HIGH;
        if (name.ends_with(L"-realtime")) priority = D3D12_COMMAND_QUEUE_PRIORITY_GLOBAL_REALTIME;
        r = runD3D12(seconds, type, priority);
      }
    } catch (const winrt::hresult_error& e) {
      r = {false, "exception " + hex(e.code())};
    }
    const auto& v = r.latenciesMs;
    double sum = 0;
    for (double x : v) sum += x;
    if (r.ok) {
      std::printf("{\"type\":\"result\",\"config\":\"%ls\",\"ok\":true,\"submits\":%zu,\"meanMs\":%.2f,\"p50Ms\":%.2f,\"p95Ms\":%.2f,"
                  "\"maxMs\":%.2f,\"perSecond\":%.1f}\n",
                  name.c_str(), v.size(), v.empty() ? 0 : sum / static_cast<double>(v.size()), percentile(v, 0.5),
                  percentile(v, 0.95), percentile(v, 1.0), static_cast<double>(v.size()) / std::max(0.001, r.seconds));
    } else {
      std::printf("{\"type\":\"result\",\"config\":\"%ls\",\"ok\":false,\"error\":\"%s\"}\n", name.c_str(), r.error.c_str());
    }
    std::fflush(stdout);
  }
  return 0;
}
