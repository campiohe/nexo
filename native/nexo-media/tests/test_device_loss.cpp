#include "share/device_loss.hpp"
#include "test.hpp"

using nexo::DeviceLossPolicy;

namespace {
constexpr int64_t s = 1'000'000;
}

TEST_CASE("device_loss", "a successful rebuild keeps the share") {
  DeviceLossPolicy p;
  CHECK(p.onLoss(10 * s));
  p.onRebuilt();
  CHECK_EQ(p.attempts(), 0);
  CHECK_EQ(p.losses(), uint64_t{1});
}

TEST_CASE("device_loss", "one failed rebuild is retried after a delay, the second gives up") {
  DeviceLossPolicy p;
  CHECK(p.onLoss(0));
  const auto delay = p.onRebuildFailed();
  CHECK(delay.has_value());
  CHECK_EQ(*delay, int64_t{2'000'000});
  CHECK(!p.onRebuildFailed().has_value()); // failed twice → ended device-lost
}

TEST_CASE("device_loss", "a failure then a success resets the attempt count for the next loss") {
  DeviceLossPolicy p;
  CHECK(p.onLoss(0));
  CHECK(p.onRebuildFailed().has_value());
  p.onRebuilt();
  CHECK(p.onLoss(30 * s));
  CHECK(p.onRebuildFailed().has_value()); // a fresh loss gets its own two attempts
}

TEST_CASE("device_loss", "a crash loop gives up, isolated losses don't") {
  DeviceLossPolicy p;
  CHECK(p.onLoss(0));
  p.onRebuilt();
  CHECK(p.onLoss(5 * s));
  p.onRebuilt();
  CHECK(p.onLoss(10 * s));
  p.onRebuilt();
  CHECK(!p.onLoss(15 * s)); // 4 losses within a minute

  DeviceLossPolicy q;
  for (int i = 0; i < 10; ++i) {
    CHECK(q.onLoss(i * 61 * s)); // one a minute: always rebuilt
    q.onRebuilt();
  }
}
