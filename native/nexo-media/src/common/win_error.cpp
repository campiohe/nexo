#include "common/win_error.hpp"

#include <cstdlib>
#include <format>

namespace nexo {

std::string describeHresult(HRESULT hr) {
  wchar_t* buf = nullptr;
  const DWORD len = FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
                                   nullptr, static_cast<DWORD>(hr), 0, reinterpret_cast<wchar_t*>(&buf), 0, nullptr);
  std::string text;
  if (len > 0 && buf) {
    text = toUtf8(std::wstring_view(buf, len));
    while (!text.empty() && (text.back() == '\n' || text.back() == '\r' || text.back() == ' ' || text.back() == '.')) {
      text.pop_back();
    }
  }
  if (buf) LocalFree(buf);
  auto code = std::format("0x{:08X}", static_cast<uint32_t>(hr));
  return text.empty() ? code : code + " " + text;
}

HrError::HrError(HRESULT hr, std::string_view what)
    : std::runtime_error(std::string(what) + ": " + describeHresult(hr)), hr_(hr) {}

std::string toUtf8(std::wstring_view wide) {
  if (wide.empty()) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()), nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()), out.data(), n, nullptr, nullptr);
  return out;
}

std::wstring toWide(std::string_view utf8) {
  if (utf8.empty()) return {};
  const int n = MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
  std::wstring out(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), out.data(), n);
  return out;
}

std::string envString(const char* name) {
  char* value = nullptr;
  size_t len = 0;
  if (_dupenv_s(&value, &len, name) != 0 || !value) return {};
  std::string out(value);
  free(value);
  return out;
}

bool envFlag(const char* name) {
  const auto v = envString(name);
  return !v.empty() && v != "0" && v != "false" && v != "off";
}

} // namespace nexo
