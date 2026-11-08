#pragma once
// The stdio protocol loop (SPEC-BETA §6): reads commands from stdin, answers each with a `result`, owns the
// current share. Exits on `shutdown`, stdin EOF, or when the parent process dies (watchdog).

#include <cstdint>
#include <optional>

namespace nexo {

struct ServerOptions {
  std::optional<uint32_t> parentPid; ///< --parent-pid=<pid>
};

/// Runs until shutdown. Returns the process exit code.
int runProtocolServer(const ServerOptions& options);

} // namespace nexo
