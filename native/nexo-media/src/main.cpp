// nexo-media.exe — native capture/encode/publish helper for Nexo (docs/SPEC-BETA.md).
//
//   nexo-media.exe [--parent-pid=<pid>]          protocol v1 on stdio (what Electron main runs)
//   nexo-media.exe --selftest                     print capabilities JSON and exit
//   nexo-media.exe --test-pattern --url <ws> --token-stdin [options]
//                                                 publish a moving pattern (M0, no game needed)
//   nexo-media.exe --version
//
// Test-pattern options: --width/--height (1920x1080) --fps (60) --bitrate (8000000) --hint motion|detail
//   --duration <s> (0 = until Ctrl+C) --dump-h264 <file> --dry-run (no LiveKit)
//
// Environment levers (all off by default): NEXO_MEDIA_LOG=debug, NEXO_MEDIA_SDK_LOG=<level>,
//   NEXO_MEDIA_DISABLE_HW=1 (forces encoder-unavailable), NEXO_MEDIA_DRY_RUN=1, NEXO_MEDIA_DUMP_H264=<file>,
//   NEXO_MEDIA_H264_PROFILE=high|main|baseline, NEXO_MEDIA_DETAIL_MAX_QP=<n>,
//   NEXO_MEDIA_GPU_PRIORITY=1, NEXO_MEDIA_GPU_SCHED_HIGH=1, NEXO_MEDIA_ABOVE_NORMAL=1, NEXO_MEDIA_D3D_DEBUG=1
#include <windows.h>

#include <mfapi.h>
#include <winrt/base.h>

#include <charconv>
#include <cstdio>
#include <iostream>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "common/log.hpp"
#include "common/win_error.hpp"
#include "d3d/device.hpp"
#include "ipc/server.hpp"
#include "publish/publisher.hpp"
#include "share/share.hpp"
#include "sys/system_info.hpp"

using namespace nexo;

namespace {

struct Args {
  std::map<std::string, std::string> values; // --key=value / --key value
  std::vector<std::string> flags;            // --flag
  bool has(const std::string& f) const {
    return std::find(flags.begin(), flags.end(), f) != flags.end() || values.count(f) > 0;
  }
  std::optional<std::string> get(const std::string& k) const {
    auto it = values.find(k);
    return it == values.end() ? std::nullopt : std::optional<std::string>(it->second);
  }
};

Args parseArgs(int argc, wchar_t** argv) {
  // Flags that never take a separate value.
  static const char* kBare[] = {"--selftest", "--test-pattern", "--token-stdin", "--dry-run", "--version", "--help"};
  Args a;
  for (int i = 1; i < argc; ++i) {
    std::string arg = toUtf8(argv[i]);
    if (arg.rfind("--", 0) != 0) continue;
    if (auto eq = arg.find('='); eq != std::string::npos) {
      a.values[arg.substr(0, eq)] = arg.substr(eq + 1);
      continue;
    }
    const bool bare = std::find_if(std::begin(kBare), std::end(kBare), [&](const char* b) { return arg == b; }) != std::end(kBare);
    if (!bare && i + 1 < argc && std::wstring_view(argv[i + 1]).rfind(L"--", 0) != 0) {
      a.values[arg] = toUtf8(argv[++i]);
    } else {
      a.flags.push_back(arg);
    }
  }
  return a;
}

template <typename T>
T number(const Args& a, const char* key, T fallback) {
  auto v = a.get(key);
  if (!v) return fallback;
  T out{};
  auto [p, ec] = std::from_chars(v->data(), v->data() + v->size(), out);
  if (ec != std::errc()) {
    log::warn("ignoring {}={} (not a number)", key, *v);
    return fallback;
  }
  return out;
}

int selftest() {
  const auto report = probeSystem();
  EventSink::instance().write(selftestJson(report).dump(-1, ' ', false, nlohmann::json::error_handler_t::replace));
  return 0;
}

winrt::handle g_ctrlC;

BOOL WINAPI onCtrl(DWORD) {
  if (g_ctrlC) SetEvent(g_ctrlC.get());
  return TRUE;
}

int testPattern(const Args& args) {
  ShareSpec spec;
  spec.kind = ShareSpec::Kind::TestPattern;
  spec.patternSize = {number<uint32_t>(args, "--width", 1920), number<uint32_t>(args, "--height", 1080)};
  spec.preset.width = spec.patternSize.width;
  spec.preset.height = spec.patternSize.height;
  spec.preset.fps = number<double>(args, "--fps", 60);
  spec.preset.maxBitrate = number<uint64_t>(args, "--bitrate", 8'000'000);
  spec.preset.contentHint = args.get("--hint") == "detail" ? ipc::ContentHint::Detail : ipc::ContentHint::Motion;
  if (auto dump = args.get("--dump-h264")) spec.dumpH264 = toWide(*dump);
  const int duration = number<int>(args, "--duration", 0);

  if (!args.has("--dry-run")) {
    auto url = args.get("--url");
    if (!url || !args.has("--token-stdin")) {
      std::cerr << "--test-pattern needs --url <ws://…> and --token-stdin (or --dry-run)\n";
      return 2;
    }
    // The token comes on stdin, never in argv (visible to every process, SPEC-BETA §4.1).
    std::string token;
    std::getline(std::cin, token);
    while (!token.empty() && (token.back() == '\r' || token.back() == ' ')) token.pop_back();
    if (token.empty()) {
      std::cerr << "no token on stdin\n";
      return 2;
    }
    EventSink::instance().addSecret(token);
    spec.livekit = ipc::LiveKitCredentials{*url, token};
  }

  std::unique_ptr<Share> share;
  try {
    share = Share::prepare(spec);
  } catch (const ShareError& e) {
    EventSink::instance().write(ipc::encodeError(e.code(), e.what()));
    return 1;
  }
  g_ctrlC.attach(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  SetConsoleCtrlHandler(onCtrl, TRUE);
  share->start();
  // Ends on Ctrl+C, after --duration, or when the share ends by itself (LiveKit gone, encoder failure).
  const DWORD timeout = duration > 0 ? static_cast<DWORD>(duration) * 1000 : INFINITE;
  const ULONGLONG deadline = GetTickCount64() + timeout;
  while (!share->finished()) {
    const DWORD left = timeout == INFINITE ? 250 : static_cast<DWORD>(std::min<ULONGLONG>(250, deadline - std::min(deadline, GetTickCount64())));
    if (WaitForSingleObject(g_ctrlC.get(), left) == WAIT_OBJECT_0) break;
    if (timeout != INFINITE && GetTickCount64() >= deadline) break;
  }
  share->requestStop();
  share->waitFinished(std::chrono::seconds(15));
  const auto reason = share->endReason();
  share.reset();
  return reason == ipc::EndReason::Stopped ? 0 : 1;
}

} // namespace

int wmain(int argc, wchar_t** argv) {
  // Physical pixels everywhere: monitor rects from Electron are physical (dipToScreenRect), and WGC sizes are too.
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  const Args args = parseArgs(argc, argv);

  if (args.has("--version")) {
    std::printf("%s\n", NEXO_MEDIA_VERSION);
    return 0;
  }
  if (args.has("--help")) {
    std::printf("nexo-media %s: see the header of src/main.cpp or docs/SPEC-BETA.md §6\n", NEXO_MEDIA_VERSION);
    return 0;
  }
  if (envString("NEXO_MEDIA_LOG") == "debug") EventSink::instance().setMinLevel(ipc::LogLevel::Debug);

  winrt::init_apartment(winrt::apartment_type::multi_threaded);
  if (FAILED(MFStartup(MF_VERSION, MFSTARTUP_FULL))) {
    EventSink::instance().write(ipc::encodeError(ipc::ErrorCode::Internal, "MFStartup failed"));
    return 1;
  }

  int code = 0;
  try {
    if (args.has("--selftest")) {
      code = selftest();
    } else if (args.has("--test-pattern")) {
      applyProcessPriorityLevers();
      code = testPattern(args);
    } else {
      applyProcessPriorityLevers();
      ServerOptions options;
      if (auto pid = args.get("--parent-pid")) {
        uint32_t value = 0;
        if (std::from_chars(pid->data(), pid->data() + pid->size(), value).ec == std::errc() && value != 0) {
          options.parentPid = value;
        } else {
          log::warn("ignoring --parent-pid={}", *pid);
        }
      }
      code = runProtocolServer(options);
    }
  } catch (const std::exception& e) {
    EventSink::instance().write(ipc::encodeError(ipc::ErrorCode::Internal, e.what()));
    code = 1;
  }

#if defined(NEXO_WITH_LIVEKIT)
  shutdownLiveKit();
#endif
  MFShutdown();
  return code;
}
