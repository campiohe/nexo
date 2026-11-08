#include "common/redact.hpp"

#include <regex>

namespace nexo {
namespace {

void replaceAll(std::string& text, std::string_view needle) {
  if (needle.empty()) return;
  for (size_t pos = text.find(needle); pos != std::string::npos; pos = text.find(needle, pos + kRedacted.size())) {
    text.replace(pos, needle.size(), kRedacted);
  }
}

} // namespace

std::string redact(std::string_view text, const std::vector<std::string>& secrets) {
  std::string out(text);
  for (const auto& secret : secrets) replaceAll(out, secret);

  // Cheap pre-checks: std::regex is slow and almost no log line needs it.
  if (out.find("eyJ") != std::string::npos) {
    // header.payload.signature, base64url. A token we were never told about is still a token.
    static const std::regex jwt(R"(eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*)");
    out = std::regex_replace(out, jwt, std::string(kRedacted));
  }
  if (out.find("access_token=") != std::string::npos) {
    static const std::regex param(R"(access_token=[^&\s"']+)");
    out = std::regex_replace(out, param, "access_token=" + std::string(kRedacted));
  }
  return out;
}

} // namespace nexo
