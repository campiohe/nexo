#include "common/redact.hpp"
#include "ipc/protocol.hpp"
#include "test.hpp"

using namespace nexo::ipc;
using nlohmann::json;

namespace {

// Copies, so a temporary decode result can't leave a dangling pointer behind.
template <typename T>
std::optional<T> as(const std::variant<Command, DecodeError>& r) {
  auto* cmd = std::get_if<Command>(&r);
  auto* value = cmd ? std::get_if<T>(cmd) : nullptr;
  return value ? std::optional<T>(*value) : std::nullopt;
}

std::optional<DecodeError> err(const std::variant<Command, DecodeError>& r) {
  auto* e = std::get_if<DecodeError>(&r);
  return e ? std::optional<DecodeError>(*e) : std::nullopt;
}

const char* kStart = R"({"id":7,"type":"start","source":{"kind":"window","hwnd":"18446744073709551615"},
  "preset":{"width":1920,"height":1080,"fps":60,"maxBitrate":8000000,"contentHint":"motion"},
  "cursor":true,"audio":"system-but-nexo","excludePid":4242,
  "livekit":{"url":"ws://10.0.0.2:7880","token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl"}})";

} // namespace

TEST_CASE("protocol", "decodes hello") {
  auto r = decodeCommand(R"({"id":1,"type":"hello","protocol":1})");
  auto c = as<HelloCommand>(r);
  CHECK(c.has_value());
  CHECK_EQ(c->id, int64_t{1});
  CHECK_EQ(c->protocol, 1);
}

TEST_CASE("protocol", "decodes start with a 64-bit hwnd") {
  auto r = decodeCommand(kStart);
  auto c = as<StartCommand>(r);
  CHECK(c.has_value());
  auto* w = std::get_if<WindowSource>(&c->source);
  CHECK(w != nullptr);
  CHECK_EQ(w->hwnd, uint64_t{18446744073709551615ull});
  CHECK_EQ(c->preset.width, 1920u);
  CHECK_EQ(c->preset.fps, 60.0);
  CHECK_EQ(c->preset.maxBitrate, uint64_t{8'000'000});
  CHECK(c->preset.contentHint == ContentHint::Motion);
  CHECK(c->audio == AudioMode::SystemButNexo);
  CHECK_EQ(c->excludePid, 4242u);
  CHECK_EQ(c->livekit.url, std::string("ws://10.0.0.2:7880"));
}

TEST_CASE("protocol", "decodes a monitor source") {
  auto r = decodeCommand(R"({"id":2,"type":"start","source":{"kind":"monitor","rect":{"x":-1920,"y":0,"width":1920,"height":1080}},
    "preset":{"width":2560,"height":1440,"fps":30,"maxBitrate":6000000,"contentHint":"detail"},
    "cursor":false,"audio":"off","excludePid":1,"livekit":{"url":"ws://x","token":"t"}})");
  auto c = as<StartCommand>(r);
  CHECK(c.has_value());
  auto* m = std::get_if<MonitorSource>(&c->source);
  CHECK(m != nullptr);
  CHECK_EQ(m->rect.x, -1920);
  CHECK_EQ(m->rect.width, 1920);
  CHECK(c->preset.contentHint == ContentHint::Detail);
  CHECK(!c->cursor);
}

TEST_CASE("protocol", "decodes partial update, stop, shutdown") {
  auto u = as<UpdateCommand>(decodeCommand(R"({"id":3,"type":"update","preset":{"maxBitrate":2500000}})"));
  CHECK(u.has_value());
  CHECK(u->preset.has_value());
  CHECK_EQ(*u->preset->maxBitrate, uint64_t{2'500'000});
  CHECK(!u->preset->fps.has_value());
  CHECK(!u->cursor.has_value());
  auto u2 = as<UpdateCommand>(decodeCommand(R"({"id":4,"type":"update","cursor":false})"));
  CHECK(u2.has_value() && u2->cursor == false && !u2->preset);
  CHECK(as<StopCommand>(decodeCommand(R"({"id":5,"type":"stop"})")).has_value());
  CHECK(as<ShutdownCommand>(decodeCommand(R"({"id":6,"type":"shutdown"})")).has_value());
}

TEST_CASE("protocol", "errors keep the id when there is one") {
  // Keep each decoded value alive: err() points into it.
  const auto r1 = decodeCommand(R"({"id":9,"type":"teleport"})");
  CHECK(err(r1).has_value() && err(r1)->id == 9);
  const auto r2 = decodeCommand(R"({"id":10,"type":"start"})");
  CHECK(err(r2).has_value() && err(r2)->id == 10);
  CHECK_EQ(err(r2)->message, std::string("start.source is required"));
  const auto r3 = decodeCommand(R"({"type":"hello","protocol":1})");
  CHECK(err(r3).has_value() && !err(r3)->id);
  const auto r4 = decodeCommand(R"({"id":11,"type":"start","source":{"kind":"window","hwnd":"12x"}})");
  CHECK(err(r4).has_value() && err(r4)->id == 11);
}

TEST_CASE("protocol", "decode errors never echo the token") {
  // Truncated line: nlohmann's own message would quote the bytes around the error.
  std::string truncated = kStart;
  truncated.resize(truncated.size() - 3);
  const auto r = decodeCommand(truncated);
  CHECK(err(r).has_value());
  CHECK(err(r)->message.find("eyJ") == std::string::npos);
  // Wrong type for the token field.
  const auto r2 = decodeCommand(R"({"id":1,"type":"start","source":{"kind":"window","hwnd":"5"},
    "preset":{"width":1920,"height":1080,"fps":60,"maxBitrate":8000000,"contentHint":"motion"},
    "cursor":true,"audio":"off","excludePid":1,"livekit":{"url":"ws://x","token":12345}})");
  CHECK(err(r2).has_value());
  CHECK(err(r2)->message.find("12345") == std::string::npos);
}

TEST_CASE("protocol", "rejects out-of-range values") {
  CHECK(err(decodeCommand(R"({"id":1,"type":"update","preset":{"fps":0}})")).has_value());
  CHECK(err(decodeCommand(R"({"id":1,"type":"update","preset":{"width":1.5}})")).has_value());
  CHECK(err(decodeCommand(R"({"id":1,"type":"update","preset":{"contentHint":"fast"}})")).has_value());
  CHECK(err(decodeCommand("[1,2]")).has_value());
}

TEST_CASE("protocol", "encodes results and events with the contract's field names") {
  auto ok = json::parse(encodeResultOk(5));
  CHECK_EQ(ok["type"], "result");
  CHECK_EQ(ok["id"], 5);
  CHECK_EQ(ok["ok"], true);
  CHECK(!ok.contains("capabilities"));

  auto bad = json::parse(encodeResultError(6, ErrorCode::EncoderUnavailable, "no MFT"));
  CHECK_EQ(bad["ok"], false);
  CHECK_EQ(bad["error"]["code"], "encoder-unavailable");
  CHECK_EQ(bad["error"]["message"], "no MFT");

  CHECK_EQ(json::parse(encodeState(State::Reconnecting))["state"], "reconnecting");
  CHECK_EQ(json::parse(encodeEnded(EndReason::SourceClosed))["reason"], "source-closed");
  auto e = json::parse(encodeError(ErrorCode::LivekitConnect, "x"));
  CHECK_EQ(e["type"], "error");
  CHECK_EQ(e["code"], "livekit-connect");
  auto l = json::parse(encodeLog(LogLevel::Warn, "careful"));
  CHECK_EQ(l["level"], "warn");
}

TEST_CASE("protocol", "every error code matches NativeShareErrorCode") {
  const char* expected[] = {"helper-unavailable", "helper-crashed", "encoder-unavailable", "capture-failed",
                            "livekit-connect",    "audio-failed",   "busy",                "protocol",
                            "internal"};
  for (int i = 0; i <= static_cast<int>(ErrorCode::Internal); ++i) {
    CHECK_EQ(std::string(toString(static_cast<ErrorCode>(i))), std::string(expected[i]));
  }
}

TEST_CASE("protocol", "capabilities: nulls and nested shapes") {
  Capabilities caps;
  caps.version = "0.4.0-dev";
  caps.osBuild = 26100;
  auto j = json::parse(encodeResultOk(1, &caps))["capabilities"];
  CHECK(j["adapter"].is_null());
  CHECK(j["encoder"].is_null());
  CHECK_EQ(j["protocol"], 1);
  CHECK_EQ(j["features"]["processLoopback"], false);
  caps.adapter = AdapterCaps{"GPU", "NVIDIA", "0x0000000000012345"};
  caps.encoder = EncoderCaps{"NVIDIA H.264 Encoder MFT", "NVIDIA"};
  j = toJson(caps);
  CHECK_EQ(j["adapter"]["luid"], "0x0000000000012345");
  CHECK_EQ(j["encoder"]["vendor"], "NVIDIA");
}

TEST_CASE("protocol", "stats: sentBitrate is optional") {
  Stats s;
  s.captureFps = 59.96;
  s.encoder = "x";
  auto j = json::parse(encodeStats(s))["stats"];
  CHECK(!j.contains("sentBitrate"));
  CHECK_EQ(j["captureFps"], 60.0);
  for (const char* key : {"captureFps", "encodeFps", "targetBitrate", "keyframes", "droppedFrames", "stalled",
                          "encoder", "width", "height"}) {
    CHECK(j.contains(key));
  }
  s.sentBitrate = 123;
  CHECK_EQ(json::parse(encodeStats(s))["stats"]["sentBitrate"], 123);
}

TEST_CASE("protocol", "redaction: explicit secrets, JWTs and access_token params") {
  std::vector<std::string> secrets{"s3cret-token"};
  CHECK_EQ(nexo::redact("connecting with s3cret-token now", secrets), std::string("connecting with [redacted] now"));
  auto jwt = nexo::redact("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl end", {});
  CHECK_EQ(jwt, std::string("token [redacted] end"));
  auto url = nexo::redact("GET ws://h:7880/rtc?access_token=abc.def&auto_subscribe=0", {});
  CHECK_EQ(url, std::string("GET ws://h:7880/rtc?access_token=[redacted]&auto_subscribe=0"));
  CHECK_EQ(nexo::redact("plain", secrets), std::string("plain"));
}
