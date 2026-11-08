#pragma once
// The helper's stdout: one JSON event per line, written from several threads (control, encode, MF work
// queue, LiveKit's FFI threads), so every write goes through one mutex. Log events are redacted (§4.1).

#include <format>
#include <mutex>
#include <string>
#include <string_view>
#include <vector>

#include "ipc/protocol.hpp"

namespace nexo {

class EventSink {
 public:
  static EventSink& instance();

  /// Writes one protocol line (a newline is appended). Thread-safe; lines never interleave.
  void write(std::string_view line);

  /// Strings that must never appear in a log event (the LiveKit token).
  void addSecret(std::string secret);

  void log(ipc::LogLevel level, std::string_view message);
  void setMinLevel(ipc::LogLevel level) { minLevel_ = level; }
  ipc::LogLevel minLevel() const { return minLevel_; }

 private:
  EventSink();
  std::mutex mutex_;
  std::vector<std::string> secrets_;
  ipc::LogLevel minLevel_ = ipc::LogLevel::Info;
  void* stdout_ = nullptr;
};

namespace log {
template <typename... Args>
void debug(std::format_string<Args...> fmt, Args&&... args) {
  auto& sink = EventSink::instance();
  if (sink.minLevel() > ipc::LogLevel::Debug) return;
  sink.log(ipc::LogLevel::Debug, std::format(fmt, std::forward<Args>(args)...));
}
template <typename... Args>
void info(std::format_string<Args...> fmt, Args&&... args) {
  EventSink::instance().log(ipc::LogLevel::Info, std::format(fmt, std::forward<Args>(args)...));
}
template <typename... Args>
void warn(std::format_string<Args...> fmt, Args&&... args) {
  EventSink::instance().log(ipc::LogLevel::Warn, std::format(fmt, std::forward<Args>(args)...));
}
template <typename... Args>
void error(std::format_string<Args...> fmt, Args&&... args) {
  EventSink::instance().log(ipc::LogLevel::Error, std::format(fmt, std::forward<Args>(args)...));
}
} // namespace log

} // namespace nexo
