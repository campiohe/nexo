#include "sys/system_info.hpp"

#include <windows.h>

#include "audio/wasapi_capture.hpp"
#include "common/log.hpp"
#include "common/win_error.hpp"

namespace nexo {
namespace {

void readOsVersion(SystemReport& r) {
  // GetVersionEx lies without a manifest; RtlGetVersion doesn't.
  using RtlGetVersionFn = LONG(WINAPI*)(OSVERSIONINFOW*);
  auto fn = reinterpret_cast<RtlGetVersionFn>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"));
  OSVERSIONINFOW info{};
  info.dwOSVersionInfoSize = sizeof(info);
  if (fn && fn(&info) == 0) {
    r.osMajor = info.dwMajorVersion;
    r.osMinor = info.dwMinorVersion;
    r.osBuild = info.dwBuildNumber;
  }
  DWORD ubr = 0, size = sizeof(ubr);
  if (RegGetValueW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", L"UBR", RRF_RT_REG_DWORD,
                   nullptr, &ubr, &size) == ERROR_SUCCESS) {
    r.osUbr = ubr;
  }
}

} // namespace

uint32_t osBuildNumber() {
  SystemReport r;
  readOsVersion(r);
  return r.osBuild;
}

SystemReport probeSystem() {
  SystemReport r;
  readOsVersion(r);
  r.processLoopbackOs = WasapiCapture::supported(r.osBuild);
  r.hwDisabled = envFlag("NEXO_MEDIA_DISABLE_HW");
  try {
    r.wgc = queryWgcFeatures();
  } catch (const std::exception& e) {
    r.problems.push_back(std::string("WGC: ") + e.what());
  }
  try {
    for (auto& adapter : listAdapters()) {
      AdapterReport a;
      a.desc = adapter;
      a.encoders = listH264Encoders(&adapter.luid);
      r.adapters.push_back(std::move(a));
    }
  } catch (const std::exception& e) {
    r.problems.push_back(std::string("adapters: ") + e.what());
  }
  if (r.adapters.empty()) r.problems.push_back("no hardware GPU adapter");
  if (!r.wgc.supported) r.problems.push_back("Windows.Graphics.Capture is not supported");
  if (r.hwDisabled) r.problems.push_back("hardware encoding disabled (NEXO_MEDIA_DISABLE_HW=1)");
  return r;
}

std::optional<AdapterChoice> chooseAdapter(const SystemReport& report) {
  if (report.hwDisabled || !report.wgc.supported) return std::nullopt;
  for (const auto& a : report.adapters) {
    if (!a.encoders.empty()) return AdapterChoice{a.desc, a.encoders.front()};
  }
  return std::nullopt;
}

ipc::Capabilities toCapabilities(const SystemReport& report) {
  ipc::Capabilities caps;
  caps.version = NEXO_MEDIA_VERSION;
  caps.osBuild = report.osBuild;
  if (auto choice = chooseAdapter(report)) {
    caps.adapter = ipc::AdapterCaps{choice->adapter.name, vendorName(choice->adapter.vendorId), luidToString(choice->adapter.luid)};
    caps.encoder = ipc::EncoderCaps{choice->encoder.name, choice->encoder.vendor};
  }
  caps.features.borderless = report.wgc.borderless;
  caps.features.minUpdateInterval = report.wgc.minUpdateInterval;
  caps.features.cursorToggle = report.wgc.cursorToggle;
  // Stream audio (SPEC-BETA §4.7): the OS has process loopback and this helper implements it.
  caps.features.processLoopback = report.processLoopbackOs;
  return caps;
}

nlohmann::json selftestJson(const SystemReport& report) {
  auto j = ipc::toJson(toCapabilities(report));
  nlohmann::json adapters = nlohmann::json::array();
  for (const auto& a : report.adapters) {
    nlohmann::json encoders = nlohmann::json::array();
    for (const auto& e : a.encoders) {
      encoders.push_back({{"name", e.name}, {"vendor", e.vendor}, {"luid", e.luid ? luidToString(*e.luid) : ""}});
    }
    adapters.push_back({{"name", a.desc.name},
                        {"vendor", vendorName(a.desc.vendorId)},
                        {"vendorId", a.desc.vendorId},
                        {"deviceId", a.desc.deviceId},
                        {"luid", luidToString(a.desc.luid)},
                        {"dedicatedVideoMemoryMB", a.desc.dedicatedVideoMemory >> 20},
                        {"h264Encoders", encoders}});
  }
  j["diagnostics"] = {
      {"os", std::to_string(report.osMajor) + "." + std::to_string(report.osMinor) + "." + std::to_string(report.osBuild) +
                 "." + std::to_string(report.osUbr)},
      {"adapters", adapters},
      {"wgc",
       {{"supported", report.wgc.supported},
        {"cursorToggle", report.wgc.cursorToggle},
        {"borderless", report.wgc.borderless},
        {"minUpdateInterval", report.wgc.minUpdateInterval},
        {"includeSecondaryWindows", report.wgc.secondaryWindows}}},
      {"processLoopbackOs", report.processLoopbackOs},
      {"audioImplemented", true},
      {"livekit",
#if defined(NEXO_WITH_LIVEKIT)
       true
#else
       false
#endif
      },
      {"problems", report.problems},
  };
  return j;
}

} // namespace nexo
