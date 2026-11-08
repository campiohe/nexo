#include "ipc/protocol.hpp"

#include <charconv>
#include <cmath>
#include <limits>

namespace nexo::ipc {
namespace {

using nlohmann::json;

/// Thrown while decoding; carries a message that names fields, never values.
struct FieldError {
  std::string message;
};

const json& field(const json& obj, const char* name, const char* where) {
  auto it = obj.find(name);
  if (it == obj.end()) throw FieldError{std::string(where) + "." + name + " is required"};
  return *it;
}

const json* optionalField(const json& obj, const char* name) {
  auto it = obj.find(name);
  if (it == obj.end() || it->is_null()) return nullptr;
  return &*it;
}

const json& object(const json& value, const std::string& what) {
  if (!value.is_object()) throw FieldError{what + " must be an object"};
  return value;
}

double number(const json& value, const std::string& what) {
  if (!value.is_number()) throw FieldError{what + " must be a number"};
  const double v = value.get<double>();
  if (!std::isfinite(v)) throw FieldError{what + " must be finite"};
  return v;
}

int64_t integer(const json& value, const std::string& what, int64_t min, int64_t max) {
  const double v = number(value, what);
  if (v != std::floor(v) || v < static_cast<double>(min) || v > static_cast<double>(max)) {
    throw FieldError{what + " is out of range"};
  }
  return static_cast<int64_t>(v);
}

bool boolean(const json& value, const std::string& what) {
  if (!value.is_boolean()) throw FieldError{what + " must be a boolean"};
  return value.get<bool>();
}

const std::string& string(const json& value, const std::string& what) {
  if (!value.is_string()) throw FieldError{what + " must be a string"};
  return value.get_ref<const std::string&>();
}

ContentHint contentHint(const json& value, const std::string& what) {
  const auto& s = string(value, what);
  if (s == "motion") return ContentHint::Motion;
  if (s == "detail") return ContentHint::Detail;
  throw FieldError{what + " must be 'motion' or 'detail'"};
}

AudioMode audioMode(const json& value) {
  const auto& s = string(value, "start.audio");
  if (s == "off") return AudioMode::Off;
  if (s == "app") return AudioMode::App;
  if (s == "system-but-nexo") return AudioMode::SystemButNexo;
  throw FieldError{"start.audio must be 'off', 'app' or 'system-but-nexo'"};
}

constexpr int64_t kMaxDimension = 16384;
constexpr int64_t kMaxBitrate = 1'000'000'000;

Source source(const json& value) {
  object(value, "start.source");
  const auto& kind = string(field(value, "kind", "start.source"), "start.source.kind");
  if (kind == "window") {
    const auto& text = string(field(value, "hwnd", "start.source"), "start.source.hwnd");
    uint64_t hwnd = 0;
    auto [end, ec] = std::from_chars(text.data(), text.data() + text.size(), hwnd, 10);
    if (ec != std::errc() || end != text.data() + text.size() || hwnd == 0) {
      throw FieldError{"start.source.hwnd must be a non-zero decimal string"};
    }
    return WindowSource{hwnd};
  }
  if (kind == "monitor") {
    const auto& r = object(field(value, "rect", "start.source"), "start.source.rect");
    constexpr int64_t lim = 1 << 20;
    Rect rect;
    rect.x = static_cast<int32_t>(integer(field(r, "x", "start.source.rect"), "start.source.rect.x", -lim, lim));
    rect.y = static_cast<int32_t>(integer(field(r, "y", "start.source.rect"), "start.source.rect.y", -lim, lim));
    rect.width = static_cast<int32_t>(integer(field(r, "width", "start.source.rect"), "start.source.rect.width", 1, lim));
    rect.height = static_cast<int32_t>(integer(field(r, "height", "start.source.rect"), "start.source.rect.height", 1, lim));
    return MonitorSource{rect};
  }
  throw FieldError{"start.source.kind must be 'window' or 'monitor'"};
}

Preset preset(const json& value) {
  object(value, "start.preset");
  Preset p;
  p.width = static_cast<uint32_t>(integer(field(value, "width", "start.preset"), "start.preset.width", 16, kMaxDimension));
  p.height = static_cast<uint32_t>(integer(field(value, "height", "start.preset"), "start.preset.height", 16, kMaxDimension));
  p.fps = number(field(value, "fps", "start.preset"), "start.preset.fps");
  if (p.fps < 1 || p.fps > 240) throw FieldError{"start.preset.fps is out of range"};
  p.maxBitrate = static_cast<uint64_t>(
      integer(field(value, "maxBitrate", "start.preset"), "start.preset.maxBitrate", 100'000, kMaxBitrate));
  p.contentHint = contentHint(field(value, "contentHint", "start.preset"), "start.preset.contentHint");
  return p;
}

PresetPatch presetPatch(const json& value) {
  object(value, "update.preset");
  PresetPatch p;
  if (auto* v = optionalField(value, "width")) p.width = static_cast<uint32_t>(integer(*v, "update.preset.width", 16, kMaxDimension));
  if (auto* v = optionalField(value, "height")) p.height = static_cast<uint32_t>(integer(*v, "update.preset.height", 16, kMaxDimension));
  if (auto* v = optionalField(value, "fps")) {
    p.fps = number(*v, "update.preset.fps");
    if (*p.fps < 1 || *p.fps > 240) throw FieldError{"update.preset.fps is out of range"};
  }
  if (auto* v = optionalField(value, "maxBitrate")) p.maxBitrate = static_cast<uint64_t>(integer(*v, "update.preset.maxBitrate", 100'000, kMaxBitrate));
  if (auto* v = optionalField(value, "contentHint")) p.contentHint = contentHint(*v, "update.preset.contentHint");
  return p;
}

Command command(const json& msg, int64_t id) {
  const auto& type = string(field(msg, "type", "command"), "command.type");
  if (type == "hello") {
    return HelloCommand{id, static_cast<int>(integer(field(msg, "protocol", "hello"), "hello.protocol", 0, 1'000'000))};
  }
  if (type == "start") {
    StartCommand c;
    c.id = id;
    c.source = source(field(msg, "source", "start"));
    c.preset = preset(field(msg, "preset", "start"));
    c.cursor = boolean(field(msg, "cursor", "start"), "start.cursor");
    c.audio = audioMode(field(msg, "audio", "start"));
    c.excludePid = static_cast<uint32_t>(integer(field(msg, "excludePid", "start"), "start.excludePid", 0, 0xFFFFFFFFLL));
    const auto& lk = object(field(msg, "livekit", "start"), "start.livekit");
    c.livekit.url = string(field(lk, "url", "start.livekit"), "start.livekit.url");
    c.livekit.token = string(field(lk, "token", "start.livekit"), "start.livekit.token");
    if (c.livekit.url.empty()) throw FieldError{"start.livekit.url must not be empty"};
    if (c.livekit.token.empty()) throw FieldError{"start.livekit.token must not be empty"};
    return c;
  }
  if (type == "update") {
    UpdateCommand c;
    c.id = id;
    if (auto* v = optionalField(msg, "preset")) c.preset = presetPatch(*v);
    if (auto* v = optionalField(msg, "cursor")) c.cursor = boolean(*v, "update.cursor");
    return c;
  }
  if (type == "stop") return StopCommand{id};
  if (type == "shutdown") return ShutdownCommand{id};
  throw FieldError{"unknown command type"};
}

std::string dump(const json& j) {
  // `replace`: a log message with invalid UTF-8 (e.g. a driver string) must not throw on the way out.
  return j.dump(-1, ' ', false, json::error_handler_t::replace);
}

} // namespace

int64_t commandId(const Command& command) {
  return std::visit([](const auto& c) { return c.id; }, command);
}

std::variant<Command, DecodeError> decodeCommand(std::string_view line) {
  json msg;
  try {
    msg = json::parse(line);
  } catch (const json::parse_error& e) {
    // nlohmann's message quotes the bytes around the error, which could be part of the token.
    return DecodeError{std::nullopt, "invalid JSON at byte " + std::to_string(e.byte)};
  }
  if (!msg.is_object()) return DecodeError{std::nullopt, "command must be a JSON object"};

  std::optional<int64_t> id;
  auto idIt = msg.find("id");
  if (idIt != msg.end() && idIt->is_number()) {
    const double v = idIt->get<double>();
    if (std::isfinite(v) && v == std::floor(v) && std::abs(v) <= 9007199254740991.0) id = static_cast<int64_t>(v);
  }
  if (!id) return DecodeError{std::nullopt, "command.id must be an integer"};

  try {
    return command(msg, *id);
  } catch (const FieldError& e) {
    return DecodeError{id, e.message};
  } catch (const json::exception&) {
    return DecodeError{id, "malformed command"};
  }
}

std::string_view toString(ErrorCode code) {
  switch (code) {
    case ErrorCode::HelperUnavailable: return "helper-unavailable";
    case ErrorCode::HelperCrashed: return "helper-crashed";
    case ErrorCode::EncoderUnavailable: return "encoder-unavailable";
    case ErrorCode::CaptureFailed: return "capture-failed";
    case ErrorCode::LivekitConnect: return "livekit-connect";
    case ErrorCode::AudioFailed: return "audio-failed";
    case ErrorCode::Busy: return "busy";
    case ErrorCode::Protocol: return "protocol";
    case ErrorCode::Internal: return "internal";
  }
  return "internal";
}

std::string_view toString(State state) {
  switch (state) {
    case State::Connecting: return "connecting";
    case State::Live: return "live";
    case State::Reconnecting: return "reconnecting";
    case State::Stopped: return "stopped";
  }
  return "stopped";
}

std::string_view toString(EndReason reason) {
  switch (reason) {
    case EndReason::SourceClosed: return "source-closed";
    case EndReason::Stopped: return "stopped";
    case EndReason::DeviceLost: return "device-lost";
    case EndReason::Error: return "error";
  }
  return "error";
}

std::string_view toString(LogLevel level) {
  switch (level) {
    case LogLevel::Debug: return "debug";
    case LogLevel::Info: return "info";
    case LogLevel::Warn: return "warn";
    case LogLevel::Error: return "error";
  }
  return "info";
}

std::string_view toString(ContentHint hint) {
  return hint == ContentHint::Detail ? "detail" : "motion";
}

std::string_view toString(AudioMode mode) {
  switch (mode) {
    case AudioMode::Off: return "off";
    case AudioMode::App: return "app";
    case AudioMode::SystemButNexo: return "system-but-nexo";
  }
  return "off";
}

nlohmann::json toJson(const Capabilities& caps) {
  json j = {
      {"version", caps.version},
      {"protocol", caps.protocol},
      {"osBuild", caps.osBuild},
      {"adapter", nullptr},
      {"encoder", nullptr},
      {"features",
       {{"borderless", caps.features.borderless},
        {"minUpdateInterval", caps.features.minUpdateInterval},
        {"cursorToggle", caps.features.cursorToggle},
        {"processLoopback", caps.features.processLoopback}}},
  };
  if (caps.adapter) {
    j["adapter"] = {{"name", caps.adapter->name}, {"vendor", caps.adapter->vendor}, {"luid", caps.adapter->luid}};
  }
  if (caps.encoder) j["encoder"] = {{"name", caps.encoder->name}, {"vendor", caps.encoder->vendor}};
  return j;
}

nlohmann::json toJson(const Stats& s) {
  // fps rounded to 0.1: the UI shows integers and shorter lines are easier to read in logs.
  auto round1 = [](double v) { return std::round(v * 10.0) / 10.0; };
  json j = {
      {"captureFps", round1(s.captureFps)},
      {"encodeFps", round1(s.encodeFps)},
      {"targetBitrate", s.targetBitrate},
      {"keyframes", s.keyframes},
      {"droppedFrames", s.droppedFrames},
      {"stalled", s.stalled},
      {"encoder", s.encoder},
      {"width", s.width},
      {"height", s.height},
  };
  if (s.sentBitrate) j["sentBitrate"] = *s.sentBitrate;
  return j;
}

std::string encodeResultOk(int64_t id, const Capabilities* capabilities) {
  json j = {{"type", "result"}, {"id", id}, {"ok", true}};
  if (capabilities) j["capabilities"] = toJson(*capabilities);
  return dump(j);
}

std::string encodeResultError(int64_t id, ErrorCode code, std::string_view message) {
  return dump({{"type", "result"},
               {"id", id},
               {"ok", false},
               {"error", {{"code", toString(code)}, {"message", message}}}});
}

std::string encodeState(State state) {
  return dump({{"type", "state"}, {"state", toString(state)}});
}

std::string encodeStats(const Stats& stats) {
  return dump({{"type", "stats"}, {"stats", toJson(stats)}});
}

std::string encodeEnded(EndReason reason) {
  return dump({{"type", "ended"}, {"reason", toString(reason)}});
}

std::string encodeError(ErrorCode code, std::string_view message) {
  return dump({{"type", "error"}, {"code", toString(code)}, {"message", message}});
}

std::string encodeLog(LogLevel level, std::string_view message) {
  return dump({{"type", "log"}, {"level", toString(level)}, {"message", message}});
}

} // namespace nexo::ipc
