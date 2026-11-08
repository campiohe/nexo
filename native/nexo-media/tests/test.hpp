#pragma once
// Minimal test harness: no dependency to fetch in CI. Each suite is a ctest test (`nexo-media-tests <suite>`).

#include <functional>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace nexo::test {

struct Case {
  const char* suite;
  const char* name;
  std::function<void()> fn;
};

std::vector<Case>& registry();
void fail(const char* file, int line, const std::string& message);

struct Registrar {
  Registrar(const char* suite, const char* name, std::function<void()> fn) {
    registry().push_back({suite, name, std::move(fn)});
  }
};

template <typename A, typename B>
void checkEq(const A& a, const B& b, const char* as, const char* bs, const char* file, int line) {
  if (!(a == b)) {
    std::ostringstream os;
    os << as << " == " << bs << "  (got " << a << " vs " << b << ")";
    fail(file, line, os.str());
  }
}

} // namespace nexo::test

#define NEXO_CAT2(a, b) a##b
#define NEXO_CAT(a, b) NEXO_CAT2(a, b)
#define TEST_CASE(suite, name)                                                                               \
  static void NEXO_CAT(test_fn_, __LINE__)();                                                                \
  static ::nexo::test::Registrar NEXO_CAT(test_reg_, __LINE__)(suite, name, &NEXO_CAT(test_fn_, __LINE__)); \
  static void NEXO_CAT(test_fn_, __LINE__)()

#define CHECK(cond)                                                    \
  do {                                                                 \
    if (!(cond)) ::nexo::test::fail(__FILE__, __LINE__, "CHECK(" #cond ")"); \
  } while (0)
#define CHECK_EQ(a, b) ::nexo::test::checkEq((a), (b), #a, #b, __FILE__, __LINE__)
