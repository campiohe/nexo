#pragma once
// Keeps secrets (the LiveKit token) out of everything the helper prints (SPEC-BETA §4.1: "never in logs").

#include <string>
#include <string_view>
#include <vector>

namespace nexo {

inline constexpr std::string_view kRedacted = "[redacted]";

/// Replaces every occurrence of each non-empty `secret`, plus anything that looks like a JWT or an
/// `access_token=` query parameter (the SDK may log signalling URLs), with "[redacted]".
std::string redact(std::string_view text, const std::vector<std::string>& secrets);

} // namespace nexo
