#include "test.hpp"

#include <cstring>

namespace nexo::test {

namespace {
int g_failures = 0;
}

std::vector<Case>& registry() {
  static std::vector<Case> cases;
  return cases;
}

void fail(const char* file, int line, const std::string& message) {
  ++g_failures;
  std::cerr << "  FAIL " << file << ":" << line << ": " << message << "\n";
}

} // namespace nexo::test

// Usage: nexo-media-tests [suite]   (no suite = every suite)
int main(int argc, char** argv) {
  using namespace nexo::test;
  const char* only = argc > 1 ? argv[1] : nullptr;
  int ran = 0, failedCases = 0;
  for (const auto& c : registry()) {
    if (only && std::strcmp(only, c.suite) != 0) continue;
    const int before = g_failures;
    try {
      c.fn();
    } catch (const std::exception& e) {
      fail(c.suite, 0, std::string("exception: ") + e.what());
    }
    ++ran;
    const bool ok = g_failures == before;
    if (!ok) ++failedCases;
    std::cout << (ok ? "ok   " : "FAIL ") << c.suite << " / " << c.name << "\n";
  }
  if (ran == 0) {
    std::cerr << "no test cases matched '" << (only ? only : "") << "'\n";
    return 2;
  }
  std::cout << ran - failedCases << "/" << ran << " passed\n";
  return failedCases == 0 ? 0 : 1;
}
