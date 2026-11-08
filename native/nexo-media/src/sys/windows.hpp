#pragma once
// Top-level windows a share can capture (the `windows` command), and the size of a minimized window.
//
// Chromium's desktopCapturer, which fills the share picker, skips minimized windows. A full-screen game
// minimizes itself as soon as you alt-tab to Nexo to open the picker, so main merges this list in.

#include <windows.h>

#include <optional>
#include <vector>

#include "ipc/protocol.hpp"
#include "video/output_size.hpp"

namespace nexo {

/// Visible, titled, unowned, uncloaked windows that aren't tool windows, minimized ones included. Windows of
/// this process are left out.
std::vector<ipc::WindowInfo> listCaptureWindows();

/// The size a minimized window comes back at (physical pixels): its restored rect, or its monitor's work area
/// when it was maximized. nullopt when the window isn't minimized or the size can't be read.
std::optional<Size> restoredWindowSize(HWND hwnd);

} // namespace nexo
