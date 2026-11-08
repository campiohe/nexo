#include "test.hpp"
#include "video/annexb.hpp"

using namespace nexo::h264;
using Bytes = std::vector<uint8_t>;

namespace {
const Bytes kSps = {0x67, 0x64, 0x00, 0x28, 0xAC, 0xD9};
const Bytes kPps = {0x68, 0xEB, 0xE3, 0xCB};
const Bytes kIdr = {0x65, 0x88, 0x84, 0x00, 0x10};
const Bytes kP = {0x41, 0x9A, 0x02};
const Bytes kAud = {0x09, 0xF0};

Bytes au(std::initializer_list<Bytes> nals, bool fourByte = true) {
  Bytes out;
  for (const auto& n : nals) {
    if (fourByte) out.push_back(0);
    out.insert(out.end(), {0, 0, 1});
    out.insert(out.end(), n.begin(), n.end());
  }
  return out;
}
} // namespace

TEST_CASE("annexb", "splits 3- and 4-byte start codes") {
  Bytes data = au({kSps}, true);
  Bytes tail = au({kPps, kIdr}, false);
  data.insert(data.end(), tail.begin(), tail.end());
  auto nals = splitNals(data);
  CHECK_EQ(nals.size(), size_t{3});
  CHECK_EQ(int(nals[0].type), int(kNalSps));
  CHECK_EQ(nals[0].offset, size_t{0});
  CHECK_EQ(int(nals[1].type), int(kNalPps));
  CHECK_EQ(int(nals[2].type), int(kNalIdr));
  auto p = nals[0].payload(data);
  CHECK(Bytes(p.begin(), p.end()) == kSps);
  auto last = nals[2].payload(data);
  CHECK(Bytes(last.begin(), last.end()) == kIdr);
}

TEST_CASE("annexb", "payload excludes the next 4-byte start code's leading zero") {
  Bytes data = au({kSps, kPps});
  auto nals = splitNals(data);
  CHECK_EQ(nals.size(), size_t{2});
  CHECK_EQ(nals[0].end - nals[0].headerOffset, kSps.size());
  CHECK_EQ(nals[1].offset, size_t{4 + kSps.size()});
}

TEST_CASE("annexb", "ignores garbage and empty input") {
  CHECK(splitNals(Bytes{}).empty());
  CHECK(splitNals(Bytes{1, 2, 3}).empty());
  CHECK(splitNals(Bytes{0, 0, 1}).empty());
}

TEST_CASE("annexb", "keyframe detection") {
  CHECK(containsIdr(au({kSps, kPps, kIdr})));
  CHECK(containsIdr(au({kAud, kIdr})));
  CHECK(!containsIdr(au({kAud, kP})));
}

TEST_CASE("annexb", "SPS header fields") {
  auto info = parseSpsHeader(kSps);
  CHECK(info.has_value());
  CHECK_EQ(int(info->profileIdc), 100);
  CHECK_EQ(int(info->levelIdc), 0x28);
  CHECK(!parseSpsHeader(kPps).has_value());
}

TEST_CASE("annexb", "repair prepends cached SPS/PPS to a bare IDR") {
  ParameterSetCache cache;
  bool repaired = true;
  auto first = au({kSps, kPps, kIdr});
  CHECK(cache.process(first, &repaired) == first);
  CHECK(!repaired);
  CHECK(cache.hasParameterSets());

  auto delta = au({kP});
  CHECK(cache.process(delta, &repaired) == delta);
  CHECK(!repaired);

  auto bare = cache.process(au({kIdr}), &repaired);
  CHECK(repaired);
  CHECK(bare == au({kSps, kPps, kIdr}));
}

TEST_CASE("annexb", "repair keeps the AUD first and only adds what is missing") {
  ParameterSetCache cache;
  cache.seed(au({kSps, kPps}));
  bool repaired = false;
  auto out = cache.process(au({kAud, kPps, kIdr}), &repaired);
  CHECK(repaired);
  CHECK(out == au({kAud, kPps, kSps, kIdr}));
}

TEST_CASE("annexb", "no repair without cached parameter sets") {
  ParameterSetCache cache;
  bool repaired = true;
  auto bare = au({kIdr});
  CHECK(cache.process(bare, &repaired) == bare);
  CHECK(!repaired);
}

TEST_CASE("annexb", "cache follows the latest SPS") {
  ParameterSetCache cache;
  const Bytes sps2 = {0x67, 0x42, 0xC0, 0x1F, 0x11};
  cache.process(au({kSps, kPps, kIdr}));
  cache.process(au({sps2, kPps, kIdr}));
  CHECK(cache.sps() == sps2);
}
