// nexo-media.exe — native capture/encode/publish helper for Nexo (docs/SPEC-BETA.md).
//
//   nexo-media.exe [--parent-pid=<pid>]          protocol v1 on stdio (what Electron main runs)
//   nexo-media.exe --selftest                     print capabilities JSON and exit
//   nexo-media.exe --test-pattern --url <ws> --token-stdin [options]
//                                                 publish a moving pattern (M0, no game needed)
//   nexo-media.exe --window <hwnd> | --monitor <index> --url <ws> --token-stdin [options]
//                                                 share a window or a monitor from the command line
//   nexo-media.exe --audio-dump <file.wav> --audio-pid <pid> [--audio-mode include|exclude] [--duration 5]
//                                                 record process-loopback audio and print its level (M2 check)
//   nexo-media.exe --scaler-compare --monitor <n> | --image <file> --out <dir> [--box 1920x1080,1280x720]
//                  [--crop x,y,w,h] [--zoom 4]   one frame through every detail scaler, as PNGs (M3)
//   nexo-media.exe --version
//
// CLI share options: --width/--height (1920x1080) --fps (60) --bitrate (8000000) --hint motion|detail
//   --duration <s> (0 = until Ctrl+C) --dump-h264 <file> --dry-run (no LiveKit) --no-cursor
//   --audio off|app|system-but-nexo  --audio-pid <pid> (app on the test pattern)  --exclude-pid <pid>
//   --dump-audio <file.wav>
//
// Environment levers (all off by default): NEXO_MEDIA_LOG=debug, NEXO_MEDIA_SDK_LOG=<level>,
//   NEXO_MEDIA_DISABLE_HW=1 (forces encoder-unavailable), NEXO_MEDIA_DRY_RUN=1, NEXO_MEDIA_DUMP_H264=<file>,
//   NEXO_MEDIA_H264_PROFILE=high|main|baseline, NEXO_MEDIA_DETAIL_MAX_QP=<n>,
//   NEXO_MEDIA_GPU_PRIORITY=0|1, NEXO_MEDIA_GPU_SCHED_HIGH=0|1, NEXO_MEDIA_ABOVE_NORMAL=0|1 (defaults in
//   d3d/device.hpp), NEXO_MEDIA_D3D_DEBUG=1, NEXO_MEDIA_SCALER=vp|bicubic|lanczos (detail scaler, default vp),
//   NEXO_MEDIA_DUMP_AUDIO=<file.wav>, NEXO_MEDIA_TEST_DEVICE_LOST_AFTER_MS=<n> and
//   NEXO_MEDIA_TEST_DEVICE_REBUILD_FAILS=<n> (simulated GPU loss and failed rebuilds, M3 tests)
// Pipeline levers (docs/benchmarks/beta-m3-fps-gap.md): NEXO_MEDIA_ZERO_COPY=0|1 (default 1: encode from WGC's
//   own buffers, no ring copy), NEXO_MEDIA_PIPELINE=0|1 (default 1: hand a frame to the encoder once its
//   conversion is done on the GPU, several in flight), NEXO_MEDIA_RGB_INPUT=0|1 (default 0: BGRA straight into
//   the MFT for 1:1 shares), NEXO_MEDIA_WGC_BUFFERS=<n> (frame pool size), NEXO_MEDIA_WGC_MIN_INTERVAL_MS=<ms>
//   (0 = unset; default 1/fps), NEXO_MEDIA_PROFILE=1 (a per-second "profile:" log line: per-stage CPU/GPU
//   timings) and NEXO_MEDIA_PROFILE_RAW=1 (with PROFILE: count WGC frames and process nothing)
#include <windows.h>

#include <mfapi.h>
#include <winrt/base.h>

#include <charconv>
#include <cstdio>
#include <iostream>
#include <map>
#include <optional>
#include <span>
#include <string>
#include <vector>

#include "audio/audio_framer.hpp"
#include "audio/wasapi_capture.hpp"
#include "audio/wav_writer.hpp"
#include "common/log.hpp"
#include "common/win_error.hpp"
#include "d3d/device.hpp"
#include "ipc/server.hpp"
#include "publish/publisher.hpp"
#include "share/share.hpp"
#include "sys/system_info.hpp"
#include "tools/scaler_compare.hpp"

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
  static const char* kBare[] = {"--selftest", "--test-pattern", "--token-stdin", "--dry-run", "--version", "--help",
                                "--no-cursor", "--scaler-compare"};
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

/// Physical rectangle of the n-th monitor (EnumDisplayMonitors order; 0 is usually the primary).
std::optional<ipc::Rect> monitorRect(int index) {
  struct Ctx {
    int want;
    int seen = 0;
    std::optional<ipc::Rect> rect;
  } ctx{index};
  EnumDisplayMonitors(
      nullptr, nullptr,
      [](HMONITOR monitor, HDC, LPRECT, LPARAM param) -> BOOL {
        auto* c = reinterpret_cast<Ctx*>(param);
        if (c->seen++ != c->want) return TRUE;
        MONITORINFO info{sizeof(info)};
        if (GetMonitorInfoW(monitor, &info)) {
          const RECT& r = info.rcMonitor;
          c->rect = ipc::Rect{r.left, r.top, r.right - r.left, r.bottom - r.top};
        }
        return FALSE;
      },
      reinterpret_cast<LPARAM>(&ctx));
  return ctx.rect;
}

std::optional<ipc::AudioMode> audioModeArg(const Args& args) {
  const auto v = args.get("--audio").value_or("off");
  if (v == "off") return ipc::AudioMode::Off;
  if (v == "app") return ipc::AudioMode::App;
  if (v == "system-but-nexo") return ipc::AudioMode::SystemButNexo;
  return std::nullopt;
}

/// --audio-dump: records process-loopback audio to a WAV and prints its level, without any video (M2 check).
int audioDump(const Args& args) {
  const auto path = *args.get("--audio-dump");
  AudioCaptureConfig config;
  config.mode = args.get("--audio-mode") == "exclude" ? LoopbackMode::ExcludeProcessTree : LoopbackMode::IncludeProcessTree;
  config.pid = number<uint32_t>(args, "--audio-pid", 0);
  if (auto hwnd = args.get("--window")) {
    DWORD pid = 0;
    GetWindowThreadProcessId(reinterpret_cast<HWND>(static_cast<uintptr_t>(std::stoull(*hwnd))), &pid);
    config.pid = pid;
  }
  if (config.pid == 0) {
    std::cerr << "--audio-dump needs --audio-pid <pid> or --window <hwnd>\n";
    return 2;
  }
  const double seconds = number<double>(args, "--duration", 5);

  WasapiCapture capture(config);
  WavWriter wav(toWide(path), WasapiCapture::kSampleRate, static_cast<uint16_t>(WasapiCapture::kChannels));
  if (!wav.ok()) {
    std::cerr << "cannot write " << path << "\n";
    return 1;
  }
  std::vector<int16_t> all; // capture thread only, read after stop()
  std::string error;
  try {
    capture.open();
    capture.start(
        [&](std::span<const int16_t> frame) {
          wav.write(frame);
          all.insert(all.end(), frame.begin(), frame.end());
        },
        [&](const std::string& message) { error = message; });
  } catch (const ShareError& e) {
    EventSink::instance().write(ipc::encodeError(e.code(), e.what()));
    return 1;
  }
  Sleep(static_cast<DWORD>(seconds * 1000));
  capture.stop();
  wav.close();
  const auto level = measureLevel(all);
  nlohmann::json out = {{"type", "audio-dump"},
                        {"file", path},
                        {"target", capture.describe()},
                        {"seconds", static_cast<double>(all.size() / WasapiCapture::kChannels) / WasapiCapture::kSampleRate},
                        {"capturedFrames", capture.capturedFrames()},
                        {"silenceFrames", capture.silenceFrames()},
                        {"discontinuities", capture.discontinuities()},
                        {"rms", level.rms},
                        {"rmsDbfs", level.rmsDbfs},
                        {"peak", level.peak}};
  if (!error.empty()) out["error"] = error;
  EventSink::instance().write(out.dump());
  return error.empty() ? 0 : 1;
}

std::vector<std::string> splitList(const std::string& s, char sep) {
  std::vector<std::string> out;
  size_t start = 0;
  for (size_t i = 0; i <= s.size(); ++i) {
    if (i == s.size() || s[i] == sep) {
      if (i > start) out.push_back(s.substr(start, i - start));
      start = i + 1;
    }
  }
  return out;
}

int scalerCompare(const Args& args) {
  ScalerCompareOptions o;
  o.outDir = toWide(args.get("--out").value_or("scaler-compare"));
  if (auto image = args.get("--image")) {
    o.image = toWide(*image);
  } else {
    const auto rect = monitorRect(number<int>(args, "--monitor", 0));
    if (!rect) {
      std::cerr << "no such monitor\n";
      return 2;
    }
    const RECT r{rect->x, rect->y, rect->x + rect->width, rect->y + rect->height};
    o.monitor = MonitorFromRect(&r, MONITOR_DEFAULTTONULL);
  }
  if (auto boxes = args.get("--box")) {
    o.boxes.clear();
    for (const auto& b : splitList(*boxes, ',')) {
      const auto wh = splitList(b, 'x');
      if (wh.size() == 2) o.boxes.push_back({static_cast<uint32_t>(std::stoul(wh[0])), static_cast<uint32_t>(std::stoul(wh[1]))});
    }
  }
  if (auto crop = args.get("--crop")) {
    const auto v = splitList(*crop, ',');
    if (v.size() == 4) {
      const int x = std::stoi(v[0]), y = std::stoi(v[1]);
      o.crop = Rect{x, y, x + std::stoi(v[2]), y + std::stoi(v[3])};
    }
  }
  o.zoom = number<uint32_t>(args, "--zoom", 4);
  return runScalerCompare(o);
}

/// --test-pattern / --window / --monitor from the command line: the same Share the protocol runs.
int cliShare(const Args& args) {
  ShareSpec spec;
  const Size box{number<uint32_t>(args, "--width", 1920), number<uint32_t>(args, "--height", 1080)};
  if (auto hwnd = args.get("--window")) {
    spec.kind = ShareSpec::Kind::Window;
    spec.hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(std::stoull(*hwnd)));
  } else if (args.get("--monitor")) {
    spec.kind = ShareSpec::Kind::Monitor;
    const auto rect = monitorRect(number<int>(args, "--monitor", 0));
    if (!rect) {
      std::cerr << "no such monitor\n";
      return 2;
    }
    spec.monitorRect = *rect;
  } else {
    spec.kind = ShareSpec::Kind::TestPattern;
    spec.patternSize = box;
  }
  spec.preset.width = box.width;
  spec.preset.height = box.height;
  spec.preset.fps = number<double>(args, "--fps", 60);
  spec.preset.maxBitrate = number<uint64_t>(args, "--bitrate", 8'000'000);
  spec.preset.contentHint = args.get("--hint") == "detail" ? ipc::ContentHint::Detail : ipc::ContentHint::Motion;
  spec.cursor = !args.has("--no-cursor");
  const auto audio = audioModeArg(args);
  if (!audio) {
    std::cerr << "--audio must be off, app or system-but-nexo\n";
    return 2;
  }
  spec.audio = *audio;
  spec.audioPid = number<uint32_t>(args, "--audio-pid", 0);
  spec.excludePid = number<uint32_t>(args, "--exclude-pid", 0);
  if (auto wav = args.get("--dump-audio")) spec.dumpWav = toWide(*wav);
  if (auto dump = args.get("--dump-h264")) spec.dumpH264 = toWide(*dump);
  const int duration = number<int>(args, "--duration", 0);

  if (!args.has("--dry-run")) {
    auto url = args.get("--url");
    if (!url || !args.has("--token-stdin")) {
      std::cerr << "a CLI share needs --url <ws://…> and --token-stdin (or --dry-run)\n";
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
    } else if (args.has("--scaler-compare")) {
      code = scalerCompare(args);
    } else if (args.has("--audio-dump")) {
      code = audioDump(args);
    } else if (args.has("--test-pattern") || args.has("--window") || args.has("--monitor")) {
      applyProcessPriorityLevers();
      code = cliShare(args);
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
  // An abandoned connect may still be inside the SDK: give it a moment, and if it's still there, skip the
  // SDK shutdown (the process exit tears everything down anyway) rather than pull the runtime from under it.
  if (waitLiveKitIdle(std::chrono::seconds(3))) {
    shutdownLiveKit();
  } else {
    log::warn("exit: a LiveKit connect is still pending, skipping the SDK shutdown");
  }
#endif
  MFShutdown();
  return code;
}
