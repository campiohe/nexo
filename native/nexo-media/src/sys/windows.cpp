#include "sys/windows.hpp"

#include <dwmapi.h>

#include <algorithm>
#include <format>
#include <string>

#include "common/win_error.hpp"

namespace nexo {
namespace {

/// Placement and monitor rects in physical pixels, whatever the process's own DPI awareness.
class PhysicalDpiScope {
 public:
  PhysicalDpiScope() : previous_(SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {}
  ~PhysicalDpiScope() {
    if (previous_) SetThreadDpiAwarenessContext(previous_);
  }
  PhysicalDpiScope(const PhysicalDpiScope&) = delete;
  PhysicalDpiScope& operator=(const PhysicalDpiScope&) = delete;

 private:
  DPI_AWARENESS_CONTEXT previous_;
};

std::string windowTitle(HWND hwnd) {
  const int length = GetWindowTextLengthW(hwnd);
  if (length <= 0) return {};
  std::wstring title(static_cast<size_t>(length) + 1, L'\0');
  const int copied = GetWindowTextW(hwnd, title.data(), length + 1);
  title.resize(static_cast<size_t>(std::max(0, copied)));
  return toUtf8(title);
}

std::string processImage(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return {};
  std::wstring path(MAX_PATH * 4, L'\0');
  DWORD size = static_cast<DWORD>(path.size());
  const BOOL ok = QueryFullProcessImageNameW(process, 0, path.data(), &size);
  CloseHandle(process);
  if (!ok) return {};
  path.resize(size);
  return toUtf8(path);
}

bool isCloaked(HWND hwnd) {
  DWORD cloaked = 0;
  return SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked != 0;
}

BOOL CALLBACK collect(HWND hwnd, LPARAM param) {
  auto& out = *reinterpret_cast<std::vector<ipc::WindowInfo>*>(param);
  if (!IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER) != nullptr) return TRUE;
  if (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) return TRUE;
  // Cloaked: on another virtual desktop, or a suspended UWP app. Not something a picker can show.
  if (isCloaked(hwnd)) return TRUE;
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (pid == GetCurrentProcessId()) return TRUE;
  auto title = windowTitle(hwnd);
  if (title.empty()) return TRUE;
  ipc::WindowInfo info;
  info.hwnd = std::format("{}", reinterpret_cast<uintptr_t>(hwnd));
  info.title = std::move(title);
  info.pid = pid;
  info.exe = processImage(pid);
  info.minimized = IsIconic(hwnd) != FALSE;
  out.push_back(std::move(info));
  return TRUE;
}

} // namespace

std::vector<ipc::WindowInfo> listCaptureWindows() {
  std::vector<ipc::WindowInfo> out;
  EnumWindows(collect, reinterpret_cast<LPARAM>(&out));
  return out;
}

std::optional<Size> restoredWindowSize(HWND hwnd) {
  if (!hwnd || !IsIconic(hwnd)) return std::nullopt;
  PhysicalDpiScope dpi;
  WINDOWPLACEMENT placement{};
  placement.length = sizeof(placement);
  if (!GetWindowPlacement(hwnd, &placement)) return std::nullopt;
  RECT r = placement.rcNormalPosition;
  if (placement.flags & WPF_RESTORETOMAXIMIZED) {
    // Maximized before it was minimized: it comes back filling its monitor's work area.
    MONITORINFO mi{};
    mi.cbSize = sizeof(mi);
    if (GetMonitorInfoW(MonitorFromRect(&placement.rcNormalPosition, MONITOR_DEFAULTTONEAREST), &mi)) r = mi.rcWork;
  }
  const LONG width = r.right - r.left;
  const LONG height = r.bottom - r.top;
  // Below this it's the minimized stub or nonsense, not a picture worth sizing the stream for.
  if (width < 64 || height < 64) return std::nullopt;
  return Size{static_cast<uint32_t>(width), static_cast<uint32_t>(height)};
}

} // namespace nexo
