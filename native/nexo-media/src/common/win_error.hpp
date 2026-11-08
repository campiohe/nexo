#pragma once
// HRESULT checks with useful messages, and the error type that maps setup failures to protocol error codes.

#include <windows.h>

#include <stdexcept>
#include <string>
#include <string_view>

#include "ipc/protocol.hpp"

namespace nexo {

/// "0x887A0005 The GPU device instance has been suspended…" (system message when there is one).
std::string describeHresult(HRESULT hr);

class HrError : public std::runtime_error {
 public:
  HrError(HRESULT hr, std::string_view what);
  HRESULT hr() const { return hr_; }

 private:
  HRESULT hr_;
};

/// Throws HrError("<what>: 0x… message") on failure.
inline void check(HRESULT hr, std::string_view what) {
  if (FAILED(hr)) throw HrError(hr, what);
}

/// A failure the protocol reports with a specific code (result.error or an `error` event).
class ShareError : public std::runtime_error {
 public:
  ShareError(ipc::ErrorCode code, const std::string& message) : std::runtime_error(message), code_(code) {}
  ipc::ErrorCode code() const { return code_; }

 private:
  ipc::ErrorCode code_;
};

std::string toUtf8(std::wstring_view wide);
std::wstring toWide(std::string_view utf8);

/// Environment flag helpers (dev/experiment levers, SPEC-BETA §4.3).
bool envFlag(const char* name);
std::string envString(const char* name);

} // namespace nexo
