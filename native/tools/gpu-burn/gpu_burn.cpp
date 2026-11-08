// gpu-burn.exe — a stand-in for an uncapped, GPU-bound game (docs/benchmarks/beta-m3-gpu-priority.md).
//
// Opens a window and renders a deliberately expensive pixel shader as fast as the GPU allows: flip-model
// swapchain, present interval 0, tearing allowed when the system supports it. The GPU sits near 100%, which is
// exactly the situation that starved the alpha's Chromium capture (SPEC-BETA §1). Harmless: it only draws.
//
//   gpu-burn.exe [--width 1920] [--height 1080] [--x 0] [--y 0] [--iterations 600] [--duration <s>]
//                [--foreground 1|0|2] [--borderless 0|1]
//
// --foreground 1 (default) makes the window the foreground window, like a game the user is playing. That
// matters: Windows' GPU scheduler favours the foreground process, and a process started from a script is
// normally refused focus. --foreground 2 also takes the focus back (once a second) whenever it loses it.
//
// stdout, one JSON object per line:
//   {"type":"ready","hwnd":"<decimal HWND>","pid":…,"tearing":true,"adapter":"…"}
//   {"type":"fps","fps":…,"frames":…,"foreground":true}   every second
//   {"type":"summary","fps":…,"seconds":…}        on exit (window closed, Esc, or --duration elapsed)
#include <windows.h>

#include <d3d11.h>
#include <d3dcompiler.h>
#include <dxgi1_6.h>
#include <winrt/base.h>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cwchar>
#include <string>

namespace {

const char* kShader = R"(
cbuffer Params : register(b0) {
  float2 size;
  float time;
  uint iterations;
};

float4 vs(uint id : SV_VertexID) : SV_Position {
  // One triangle covering the screen.
  float2 p = float2((id << 1) & 2, id & 2);
  return float4(p * float2(2, -2) + float2(-1, 1), 0, 1);
}

float4 ps(float4 pos : SV_Position) : SV_Target {
  float2 uv = pos.xy / size;
  float2 z = (uv - 0.5) * float2(3.2, 1.8);
  float2 c = float2(0.35 * sin(time * 0.7), 0.35 * cos(time * 0.5));
  float acc = 0;
  // Fixed cost per pixel (no early exit), so the load doesn't depend on what is on screen.
  [loop] for (uint i = 0; i < iterations; ++i) {
    z = float2(sin(z.x * 1.7 + z.y) , cos(z.y * 1.3 - z.x)) * 0.98 + c;
    acc += dot(z, z);
  }
  acc /= iterations;
  float3 color = 0.5 + 0.5 * cos(float3(0, 2, 4) + acc * 3 + time);
  // A bar sweeping across, so every frame differs (WGC only delivers frames that changed).
  float bar = step(abs(frac(uv.x - time * 0.25) - 0.5), 0.01);
  return float4(lerp(color, float3(1, 1, 1), bar), 1);
}
)";

struct Params {
  float width;
  float height;
  float time;
  UINT iterations;
};

bool g_quit = false;

/// The foreground lock refuses SetForegroundWindow to a process that didn't receive the last input. Attaching
/// to the current foreground thread's input queue is the usual way around it for a test tool.
void forceForeground(HWND hwnd) {
  const DWORD fgThread = GetWindowThreadProcessId(GetForegroundWindow(), nullptr);
  const DWORD self = GetCurrentThreadId();
  const bool attached = fgThread != 0 && fgThread != self && AttachThreadInput(self, fgThread, TRUE);
  ShowWindow(hwnd, SW_SHOW);
  BringWindowToTop(hwnd);
  SetForegroundWindow(hwnd);
  if (attached) AttachThreadInput(self, fgThread, FALSE);
}

LRESULT CALLBACK wndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_CLOSE: g_quit = true; return 0;
    case WM_KEYDOWN:
      if (wp == VK_ESCAPE) g_quit = true;
      return 0;
    default: return DefWindowProcW(hwnd, msg, wp, lp);
  }
}

void check(HRESULT hr, const char* what) {
  if (FAILED(hr)) {
    std::fprintf(stderr, "gpu-burn: %s failed: 0x%08lX\n", what, static_cast<unsigned long>(hr));
    std::exit(1);
  }
}

winrt::com_ptr<ID3DBlob> compile(const char* entry, const char* target) {
  winrt::com_ptr<ID3DBlob> code;
  winrt::com_ptr<ID3DBlob> errors;
  const HRESULT hr = D3DCompile(kShader, std::strlen(kShader), "gpu-burn", nullptr, nullptr, entry, target,
                                D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, code.put(), errors.put());
  if (FAILED(hr)) {
    std::fprintf(stderr, "gpu-burn: shader %s: %s\n", entry, errors ? static_cast<const char*>(errors->GetBufferPointer()) : "?");
    std::exit(1);
  }
  return code;
}

int intArg(int argc, wchar_t** argv, const wchar_t* name, int fallback) {
  for (int i = 1; i + 1 < argc; ++i) {
    if (std::wcscmp(argv[i], name) == 0) return _wtoi(argv[i + 1]);
  }
  return fallback;
}

} // namespace

int wmain(int argc, wchar_t** argv) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  const int width = intArg(argc, argv, L"--width", 1920);
  const int height = intArg(argc, argv, L"--height", 1080);
  const int x = intArg(argc, argv, L"--x", 0);
  const int y = intArg(argc, argv, L"--y", 0);
  const UINT iterations = static_cast<UINT>(intArg(argc, argv, L"--iterations", 600));
  const int duration = intArg(argc, argv, L"--duration", 0);
  const int foregroundMode = intArg(argc, argv, L"--foreground", 1);
  const bool wantForeground = foregroundMode != 0;
  const bool keepForeground = foregroundMode == 2;
  const bool borderless = intArg(argc, argv, L"--borderless", 0) != 0;

  // The high-performance GPU, where a real game would run.
  winrt::com_ptr<IDXGIFactory6> factory;
  check(CreateDXGIFactory2(0, IID_PPV_ARGS(factory.put())), "CreateDXGIFactory2");
  winrt::com_ptr<IDXGIAdapter1> adapter;
  check(factory->EnumAdapterByGpuPreference(0, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE, IID_PPV_ARGS(adapter.put())), "EnumAdapterByGpuPreference");
  DXGI_ADAPTER_DESC1 adesc{};
  adapter->GetDesc1(&adesc);
  BOOL tearing = FALSE;
  if (auto f5 = factory.try_as<IDXGIFactory5>()) {
    if (FAILED(f5->CheckFeatureSupport(DXGI_FEATURE_PRESENT_ALLOW_TEARING, &tearing, sizeof(tearing)))) tearing = FALSE;
  }

  WNDCLASSW wc{};
  wc.lpfnWndProc = wndProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.lpszClassName = L"NexoGpuBurn";
  RegisterClassW(&wc);
  // --borderless 1: a popup exactly width x height, like a game in borderless full screen (what WGC then
  // captures is exactly the game's picture, no title bar or frame).
  const DWORD style = borderless ? WS_POPUP : WS_OVERLAPPEDWINDOW;
  RECT r{0, 0, width, height};
  AdjustWindowRect(&r, style, FALSE);
  HWND hwnd = CreateWindowExW(0, wc.lpszClassName, L"nexo gpu-burn", style, x, y, r.right - r.left, r.bottom - r.top, nullptr,
                              nullptr, wc.hInstance, nullptr);
  if (!hwnd) check(HRESULT_FROM_WIN32(GetLastError()), "CreateWindowEx");
  if (wantForeground) {
    forceForeground(hwnd);
  } else {
    // Visible but not activated: a game left in the background (alt-tabbed away).
    ShowWindow(hwnd, SW_SHOWNOACTIVATE);
  }

  winrt::com_ptr<ID3D11Device> device;
  winrt::com_ptr<ID3D11DeviceContext> context;
  const D3D_FEATURE_LEVEL level = D3D_FEATURE_LEVEL_11_0;
  check(D3D11CreateDevice(adapter.get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, 0, &level, 1, D3D11_SDK_VERSION, device.put(), nullptr,
                          context.put()),
        "D3D11CreateDevice");

  DXGI_SWAP_CHAIN_DESC1 sd{};
  sd.Width = static_cast<UINT>(width);
  sd.Height = static_cast<UINT>(height);
  sd.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  sd.SampleDesc.Count = 1;
  sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
  sd.BufferCount = 3;
  sd.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
  sd.Flags = tearing ? DXGI_SWAP_CHAIN_FLAG_ALLOW_TEARING : 0;
  winrt::com_ptr<IDXGIFactory2> f2 = factory.as<IDXGIFactory2>();
  winrt::com_ptr<IDXGISwapChain1> swapchain;
  check(f2->CreateSwapChainForHwnd(device.get(), hwnd, &sd, nullptr, nullptr, swapchain.put()), "CreateSwapChainForHwnd");
  f2->MakeWindowAssociation(hwnd, DXGI_MWA_NO_ALT_ENTER);

  winrt::com_ptr<ID3D11Texture2D> backbuffer;
  check(swapchain->GetBuffer(0, IID_PPV_ARGS(backbuffer.put())), "GetBuffer");
  winrt::com_ptr<ID3D11RenderTargetView> rtv;
  check(device->CreateRenderTargetView(backbuffer.get(), nullptr, rtv.put()), "CreateRenderTargetView");

  const auto vsCode = compile("vs", "vs_5_0");
  const auto psCode = compile("ps", "ps_5_0");
  winrt::com_ptr<ID3D11VertexShader> vs;
  winrt::com_ptr<ID3D11PixelShader> ps;
  check(device->CreateVertexShader(vsCode->GetBufferPointer(), vsCode->GetBufferSize(), nullptr, vs.put()), "CreateVertexShader");
  check(device->CreatePixelShader(psCode->GetBufferPointer(), psCode->GetBufferSize(), nullptr, ps.put()), "CreatePixelShader");
  D3D11_BUFFER_DESC bd{};
  bd.ByteWidth = sizeof(Params);
  bd.Usage = D3D11_USAGE_DYNAMIC;
  bd.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
  bd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
  winrt::com_ptr<ID3D11Buffer> cb;
  check(device->CreateBuffer(&bd, nullptr, cb.put()), "CreateBuffer");

  std::printf("{\"type\":\"ready\",\"hwnd\":\"%llu\",\"pid\":%lu,\"tearing\":%s,\"iterations\":%u,\"adapter\":\"%ls\"}\n",
              static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(hwnd)), GetCurrentProcessId(), tearing ? "true" : "false",
              iterations, adesc.Description);
  std::fflush(stdout);

  using clock = std::chrono::steady_clock;
  const auto start = clock::now();
  auto windowStart = start;
  uint64_t frames = 0;
  uint64_t windowFrames = 0;
  const D3D11_VIEWPORT vp{0, 0, static_cast<float>(width), static_cast<float>(height), 0, 1};
  while (!g_quit) {
    MSG msg;
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
    const auto now = clock::now();
    const double t = std::chrono::duration<double>(now - start).count();
    if (duration > 0 && t >= duration) break;

    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (SUCCEEDED(context->Map(cb.get(), 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped))) {
      *static_cast<Params*>(mapped.pData) = Params{static_cast<float>(width), static_cast<float>(height), static_cast<float>(t), iterations};
      context->Unmap(cb.get(), 0);
    }
    ID3D11RenderTargetView* targets[] = {rtv.get()};
    context->OMSetRenderTargets(1, targets, nullptr);
    context->RSSetViewports(1, &vp);
    context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    context->VSSetShader(vs.get(), nullptr, 0);
    context->PSSetShader(ps.get(), nullptr, 0);
    ID3D11Buffer* cbs[] = {cb.get()};
    context->PSSetConstantBuffers(0, 1, cbs);
    context->Draw(3, 0);
    // Uncapped: no vsync, tearing when allowed. Flip-model discard keeps the back buffer bound as RTV 0.
    const HRESULT hr = swapchain->Present(0, tearing ? DXGI_PRESENT_ALLOW_TEARING : 0);
    if (FAILED(hr)) check(hr, "Present");
    ++frames;
    ++windowFrames;

    const double windowSeconds = std::chrono::duration<double>(now - windowStart).count();
    if (windowSeconds >= 1.0) {
      const HWND fg = GetForegroundWindow();
      const bool isForeground = fg == hwnd;
      // Who has the focus instead (benchmark hygiene: something else taking it skews the results).
      wchar_t fgExe[MAX_PATH] = L"";
      if (!isForeground && fg) {
        DWORD pid = 0;
        GetWindowThreadProcessId(fg, &pid);
        if (HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)) {
          DWORD len = MAX_PATH;
          if (QueryFullProcessImageNameW(p, 0, fgExe, &len)) {
            if (const wchar_t* slash = std::wcsrchr(fgExe, L'\\')) std::wmemmove(fgExe, slash + 1, std::wcslen(slash + 1) + 1);
          }
          CloseHandle(p);
        }
      }
      std::printf("{\"type\":\"fps\",\"fps\":%.1f,\"frames\":%llu,\"foreground\":%s,\"foregroundExe\":\"%ls\"}\n",
                  static_cast<double>(windowFrames) / windowSeconds, static_cast<unsigned long long>(frames),
                  isForeground ? "true" : "false", fgExe);
      if (keepForeground && !isForeground) forceForeground(hwnd);
      std::fflush(stdout);
      windowStart = now;
      windowFrames = 0;
    }
  }
  const double total = std::chrono::duration<double>(clock::now() - start).count();
  std::printf("{\"type\":\"summary\",\"fps\":%.1f,\"seconds\":%.1f}\n", static_cast<double>(frames) / total, total);
  std::fflush(stdout);
  DestroyWindow(hwnd);
  return 0;
}
