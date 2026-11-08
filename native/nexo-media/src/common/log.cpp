#include "common/log.hpp"

#include <windows.h>

#include "common/redact.hpp"

namespace nexo {

EventSink& EventSink::instance() {
  static EventSink sink;
  return sink;
}

EventSink::EventSink() : stdout_(GetStdHandle(STD_OUTPUT_HANDLE)) {}

void EventSink::write(std::string_view line) {
  std::string buf;
  buf.reserve(line.size() + 1);
  buf.append(line);
  buf.push_back('\n');
  std::lock_guard lock(mutex_);
  // WriteFile, not std::cout: no CRT text-mode translation and no buffering surprises at exit. A short write
  // only happens on a broken pipe (main is gone), and then nobody is reading anyway.
  const char* p = buf.data();
  size_t left = buf.size();
  while (left > 0) {
    DWORD written = 0;
    if (!WriteFile(static_cast<HANDLE>(stdout_), p, static_cast<DWORD>(left), &written, nullptr) || written == 0) break;
    p += written;
    left -= written;
  }
}

void EventSink::addSecret(std::string secret) {
  // A very short "secret" would redact ordinary words (a test token "t" eats every t). Real LiveKit tokens are
  // JWTs, hundreds of characters long, and the JWT pattern in redact() covers them anyway.
  if (secret.size() < 8) return;
  std::lock_guard lock(mutex_);
  secrets_.push_back(std::move(secret));
}

void EventSink::log(ipc::LogLevel level, std::string_view message) {
  if (level < minLevel_) return;
  std::vector<std::string> secrets;
  {
    std::lock_guard lock(mutex_);
    secrets = secrets_;
  }
  write(ipc::encodeLog(level, redact(message, secrets)));
}

} // namespace nexo
