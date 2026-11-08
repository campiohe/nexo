#pragma once
// What this PC can do: OS build, GPUs, hardware H.264 encoders per GPU, WGC features. Feeds `hello`'s
// capabilities and `--selftest` (bug reports, CI).

#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "capture/wgc.hpp"
#include "d3d/device.hpp"
#include "ipc/protocol.hpp"
#include "video/encoder_mf.hpp"

namespace nexo {

struct AdapterReport {
  AdapterDesc desc;
  std::vector<H264EncoderInfo> encoders;
};

struct SystemReport {
  uint32_t osBuild = 0;
  uint32_t osUbr = 0; ///< update build revision (the ".xxxx" after the build)
  uint32_t osMajor = 0;
  uint32_t osMinor = 0;
  std::vector<AdapterReport> adapters;
  WgcFeatures wgc;
  /// The OS supports WASAPI process loopback (build 19041+, see WasapiCapture::supported).
  bool processLoopbackOs = false;
  bool hwDisabled = false; ///< NEXO_MEDIA_DISABLE_HW=1
  std::vector<std::string> problems;
};

/// Needs COM (MTA) and MFStartup.
SystemReport probeSystem();
/// Windows build number (RtlGetVersion: GetVersionEx lies without a manifest). Cheap.
uint32_t osBuildNumber();

struct AdapterChoice {
  AdapterDesc adapter;
  H264EncoderInfo encoder;
};
/// High-performance first, then the first adapter that also has a hardware H.264 MFT (SPEC-BETA §4.3).
std::optional<AdapterChoice> chooseAdapter(const SystemReport& report);

ipc::Capabilities toCapabilities(const SystemReport& report);
/// HelperCapabilities plus diagnostics (every adapter and its encoders, OS details).
nlohmann::json selftestJson(const SystemReport& report);

} // namespace nexo
