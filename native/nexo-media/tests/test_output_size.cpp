#include "test.hpp"
#include "video/output_size.hpp"

using nexo::Rect;
using nexo::Size;

namespace nexo {
std::ostream& operator<<(std::ostream& os, const Size& s) { return os << s.width << "x" << s.height; }
std::ostream& operator<<(std::ostream& os, const Rect& r) {
  return os << "[" << r.left << "," << r.top << " " << r.width() << "x" << r.height() << "]";
}
} // namespace nexo

TEST_CASE("output_size", "4K into 1080p box") {
  CHECK_EQ(nexo::pickOutputSize({3840, 2160}, {1920, 1080}), (Size{1920, 1080}));
}

TEST_CASE("output_size", "never upscales") {
  CHECK_EQ(nexo::pickOutputSize({1280, 720}, {1920, 1080}), (Size{1280, 720}));
  CHECK_EQ(nexo::pickOutputSize({1920, 1080}, {1920, 1080}), (Size{1920, 1080}));
}

TEST_CASE("output_size", "ultrawide keeps aspect inside the box") {
  CHECK_EQ(nexo::pickOutputSize({3440, 1440}, {1920, 1080}), (Size{1920, 802}));
  CHECK_EQ(nexo::pickOutputSize({2560, 1080}, {1920, 1080}), (Size{1920, 810}));
}

TEST_CASE("output_size", "portrait window") {
  CHECK_EQ(nexo::pickOutputSize({1080, 1920}, {1920, 1080}), (Size{606, 1080}));
}

TEST_CASE("output_size", "odd sizes round down to even") {
  CHECK_EQ(nexo::pickOutputSize({1366, 768}, {1280, 720}), (Size{1280, 718}));
  CHECK_EQ(nexo::pickOutputSize({801, 601}, {1920, 1080}), (Size{800, 600}));
}

TEST_CASE("output_size", "tiny sources get the minimum") {
  CHECK_EQ(nexo::pickOutputSize({3, 3}, {1920, 1080}), (Size{16, 16}));
}

TEST_CASE("output_size", "letterbox: same aspect fills the output") {
  CHECK_EQ(nexo::letterboxRect({3840, 2160}, {1920, 1080}), (Rect{0, 0, 1920, 1080}));
}

TEST_CASE("output_size", "letterbox: narrower content gets side bars") {
  auto r = nexo::letterboxRect({1024, 768}, {1920, 1080});
  CHECK_EQ(r.height(), 1080);
  CHECK_EQ(r.width(), 1440);
  CHECK_EQ(r.left, 240);
  CHECK_EQ(r.left % 2, 0);
}

TEST_CASE("output_size", "letterbox: wider content gets top/bottom bars, even edges") {
  auto r = nexo::letterboxRect({2560, 1000}, {1920, 1080});
  CHECK_EQ(r.width(), 1920);
  CHECK_EQ(r.height() % 2, 0);
  CHECK_EQ(r.top % 2, 0);
  CHECK(r.top > 0);
  CHECK(r.bottom <= 1080);
}

TEST_CASE("output_size", "letterbox: small content is scaled up to fit") {
  auto r = nexo::letterboxRect({960, 540}, {1920, 1080});
  CHECK_EQ(r, (Rect{0, 0, 1920, 1080}));
}
