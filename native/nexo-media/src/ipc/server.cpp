#include "ipc/server.hpp"

#include <windows.h>

#include <atomic>
#include <chrono>
#include <format>
#include <memory>
#include <string>
#include <thread>

#include "common/log.hpp"
#include "common/win_error.hpp"
#include "ipc/protocol.hpp"
#include "share/share.hpp"
#include "sys/system_info.hpp"

namespace nexo {
namespace {

using namespace std::chrono_literals;

// The supervisor gives `stop` 5 s. Leave margin for writing the result.
constexpr auto kStopWait = 4s;

void emit(std::string_view line) {
  EventSink::instance().write(line);
}

class Controller {
 public:
  /// False when the loop should end (shutdown).
  bool handle(const ipc::Command& command) {
    return std::visit([this](const auto& c) { return on(c); }, command);
  }

  /// Best-effort clean stop on exit.
  void shutdown() {
    if (share_) {
      share_->requestStop();
      if (!share_->waitFinished(kStopWait)) {
        log::warn("shutdown: the share did not stop in time");
        abandoned_ = true;
      }
    }
  }
  bool abandoned() const { return abandoned_; }

 private:
  /// A share that ended on its own (source closed, error) is gone; a stopping one still counts as busy.
  void reap() {
    if (share_ && share_->finished()) share_.reset();
  }

  bool on(const ipc::HelloCommand& c) {
    if (c.protocol != ipc::kProtocolVersion) {
      emit(ipc::encodeResultError(c.id, ipc::ErrorCode::Protocol,
                                  std::format("protocol {} not supported (helper speaks {})", c.protocol, ipc::kProtocolVersion)));
      return true;
    }
    const auto report = probeSystem();
    const auto caps = toCapabilities(report);
    emit(ipc::encodeResultOk(c.id, &caps));
    for (const auto& p : report.problems) log::info("capabilities: {}", p);
    return true;
  }

  bool on(const ipc::StartCommand& c) {
    reap();
    if (share_) {
      emit(ipc::encodeResultError(c.id, ipc::ErrorCode::Busy, "a share is already running"));
      return true;
    }
    EventSink::instance().addSecret(c.livekit.token);
    if (c.audio != ipc::AudioMode::Off) {
      log::warn("audio '{}' requested: stream audio is not implemented yet (M2), sharing video only", ipc::toString(c.audio));
    }
    ShareSpec spec;
    if (auto* w = std::get_if<ipc::WindowSource>(&c.source)) {
      spec.kind = ShareSpec::Kind::Window;
      spec.hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(w->hwnd));
    } else {
      spec.kind = ShareSpec::Kind::Monitor;
      spec.monitorRect = std::get<ipc::MonitorSource>(c.source).rect;
    }
    spec.preset = c.preset;
    spec.cursor = c.cursor;
    if (envFlag("NEXO_MEDIA_DRY_RUN")) {
      log::warn("NEXO_MEDIA_DRY_RUN=1: not connecting to LiveKit, frames are discarded");
    } else {
      spec.livekit = c.livekit;
    }
    if (auto dump = envString("NEXO_MEDIA_DUMP_H264"); !dump.empty()) spec.dumpH264 = toWide(dump);

    try {
      share_ = Share::prepare(spec);
    } catch (const ShareError& e) {
      log::warn("start failed ({}): {}", ipc::toString(e.code()), e.what());
      emit(ipc::encodeResultError(c.id, e.code(), e.what()));
      return true;
    } catch (const std::exception& e) {
      log::error("start failed: {}", e.what());
      emit(ipc::encodeResultError(c.id, ipc::ErrorCode::Internal, e.what()));
      return true;
    }
    // Result first, then the share's own events (connecting → live) from its thread.
    emit(ipc::encodeResultOk(c.id));
    share_->start();
    return true;
  }

  bool on(const ipc::UpdateCommand& c) {
    reap();
    if (!share_ || share_->finished()) {
      emit(ipc::encodeResultOk(c.id)); // nothing to update: harmless
      return true;
    }
    try {
      share_->update(c.preset, c.cursor);
      emit(ipc::encodeResultOk(c.id));
    } catch (const ShareError& e) {
      emit(ipc::encodeResultError(c.id, e.code(), e.what()));
    } catch (const std::exception& e) {
      emit(ipc::encodeResultError(c.id, ipc::ErrorCode::Internal, e.what()));
    }
    return true;
  }

  bool on(const ipc::StopCommand& c) {
    if (share_) {
      share_->requestStop();
      if (share_->waitFinished(kStopWait)) {
        share_.reset();
      } else {
        // Still tearing down (e.g. stuck in a LiveKit connect). It finishes in the background; a new start
        // answers `busy` until it has.
        log::warn("stop: the share is still shutting down");
      }
    }
    emit(ipc::encodeResultOk(c.id));
    return true;
  }

  bool on(const ipc::ShutdownCommand& c) {
    shutdown();
    emit(ipc::encodeResultOk(c.id));
    return false;
  }

  std::unique_ptr<Share> share_;
  bool abandoned_ = false;
};

/// Reads stdin in raw chunks so EOF and cancellation (watchdog) are both visible.
class LineReader {
 public:
  explicit LineReader(HANDLE in) : in_(in) {}
  /// False on EOF or error.
  bool next(std::string& line) {
    for (;;) {
      const auto nl = buffer_.find('\n');
      if (nl != std::string::npos) {
        line = buffer_.substr(0, nl);
        buffer_.erase(0, nl + 1);
        if (!line.empty() && line.back() == '\r') line.pop_back();
        return true;
      }
      char chunk[4096];
      DWORD read = 0;
      if (!ReadFile(in_, chunk, sizeof(chunk), &read, nullptr) || read == 0) {
        if (!buffer_.empty()) { // last line without a newline
          line = std::move(buffer_);
          buffer_.clear();
          return true;
        }
        return false;
      }
      buffer_.append(chunk, read);
      if (buffer_.size() > (1u << 20)) buffer_.clear(); // a 1 MB line is garbage, not a command
    }
  }

 private:
  HANDLE in_;
  std::string buffer_;
};

std::atomic<bool> g_parentGone{false};

/// SPEC-BETA §4.1: never outlive Electron. Waits on the parent's process handle; when it exits, unblocks the
/// stdin read so the main loop can stop the share, and hard-exits if that takes too long.
std::thread startWatchdog(uint32_t pid, HANDLE mainThread) {
  HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, pid);
  if (!parent) {
    log::error("watchdog: parent process {} not found, exiting", pid);
    ExitProcess(3);
  }
  return std::thread([parent, mainThread, pid] {
    SetThreadDescription(GetCurrentThread(), L"nexo watchdog");
    WaitForSingleObject(parent, INFINITE);
    CloseHandle(parent);
    log::warn("watchdog: parent process {} exited, shutting down", pid);
    g_parentGone = true;
    CancelSynchronousIo(mainThread);
    Sleep(5000);
    ExitProcess(4); // graceful shutdown didn't finish
  });
}

} // namespace

int runProtocolServer(const ServerOptions& options) {
  HANDLE mainThread = nullptr;
  DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &mainThread, 0, FALSE, DUPLICATE_SAME_ACCESS);
  std::thread watchdog;
  if (options.parentPid) {
    watchdog = startWatchdog(*options.parentPid, mainThread);
    watchdog.detach();
  }

  log::info("nexo-media {} ready (protocol {}, pid {})", NEXO_MEDIA_VERSION, ipc::kProtocolVersion, GetCurrentProcessId());
  Controller controller;
  LineReader reader(GetStdHandle(STD_INPUT_HANDLE));
  std::string line;
  bool running = true;
  while (running && reader.next(line)) {
    if (line.find_first_not_of(" \t") == std::string::npos) continue;
    auto decoded = ipc::decodeCommand(line);
    if (auto* err = std::get_if<ipc::DecodeError>(&decoded)) {
      if (err->id) {
        emit(ipc::encodeResultError(*err->id, ipc::ErrorCode::Protocol, err->message));
      } else {
        log::warn("ignored a malformed command: {}", err->message);
      }
      continue;
    }
    try {
      running = controller.handle(std::get<ipc::Command>(decoded));
    } catch (const std::exception& e) {
      emit(ipc::encodeResultError(ipc::commandId(std::get<ipc::Command>(decoded)), ipc::ErrorCode::Internal, e.what()));
    }
  }
  if (running) {
    log::info("{}", g_parentGone ? "parent gone: stopping" : "stdin closed: stopping");
    controller.shutdown();
  }
  // mainThread stays open: the detached watchdog may still use it until the process exits.
  return controller.abandoned() ? 5 : 0;
}

} // namespace nexo
