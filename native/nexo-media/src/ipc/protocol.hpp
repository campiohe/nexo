#pragma once
// Protocol v1 between Electron main and nexo-media.exe (docs/SPEC-BETA.md §6).
// Newline-delimited JSON over stdio: commands on stdin, events on stdout, one object per line.
//
// Mirror of desktop/src/main/native-media/protocol.ts (the contract) and of NativeShareErrorCode in
// desktop/src/preload/api.ts. Field names, string enums and optionality must match those files exactly.

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <variant>

#include <nlohmann/json.hpp>

namespace nexo::ipc {

inline constexpr int kProtocolVersion = 1;

// ── Shared pieces ──────────────────────────────────────────────────────────────────────────────────────

/// HelperRect: physical (not DIP) desktop coordinates.
struct Rect {
  int32_t x = 0;
  int32_t y = 0;
  int32_t width = 0;
  int32_t height = 0;
};

/// { kind: 'window'; hwnd: string } — HWND as a decimal string (64-bit safe).
struct WindowSource {
  uint64_t hwnd = 0;
};
/// { kind: 'monitor'; rect: HelperRect } — resolved with MonitorFromRect.
struct MonitorSource {
  Rect rect;
};
using Source = std::variant<WindowSource, MonitorSource>;

/// NativeShareContentHint: 'motion' | 'detail'.
enum class ContentHint { Motion, Detail };

/// HelperPreset
struct Preset {
  uint32_t width = 0;
  uint32_t height = 0;
  double fps = 0;
  uint64_t maxBitrate = 0; ///< bits per second
  ContentHint contentHint = ContentHint::Motion;
};

/// Partial<HelperPreset> (update command).
struct PresetPatch {
  std::optional<uint32_t> width;
  std::optional<uint32_t> height;
  std::optional<double> fps;
  std::optional<uint64_t> maxBitrate;
  std::optional<ContentHint> contentHint;
};

/// HelperAudioMode: 'off' | 'app' | 'system-but-nexo'.
enum class AudioMode { Off, App, SystemButNexo };

struct LiveKitCredentials {
  std::string url;
  std::string token; ///< Never logged.
};

// ── Commands (main → helper) ───────────────────────────────────────────────────────────────────────────

struct HelloCommand {
  int64_t id = 0;
  int protocol = 0;
};
struct StartCommand {
  int64_t id = 0;
  Source source;
  Preset preset;
  bool cursor = true;
  AudioMode audio = AudioMode::Off;
  uint32_t excludePid = 0;
  LiveKitCredentials livekit;
};
struct UpdateCommand {
  int64_t id = 0;
  std::optional<PresetPatch> preset;
  std::optional<bool> cursor;
};
struct StopCommand {
  int64_t id = 0;
};
struct ShutdownCommand {
  int64_t id = 0;
};
using Command = std::variant<HelloCommand, StartCommand, UpdateCommand, StopCommand, ShutdownCommand>;

int64_t commandId(const Command& command);

/// A line that is not a valid command. `id` is set when the line had a numeric id (so a `result` can answer).
/// `message` never echoes input values (the line may contain the token).
struct DecodeError {
  std::optional<int64_t> id;
  std::string message;
};

std::variant<Command, DecodeError> decodeCommand(std::string_view line);

// ── Events (helper → main) ─────────────────────────────────────────────────────────────────────────────

/// NativeShareErrorCode (desktop/src/preload/api.ts).
enum class ErrorCode {
  HelperUnavailable,
  HelperCrashed,
  EncoderUnavailable,
  CaptureFailed,
  LivekitConnect,
  AudioFailed,
  Busy,
  Protocol,
  Internal,
};

/// HelperState
enum class State { Connecting, Live, Reconnecting, Stopped };

/// Exclude<NativeShareEndReason, 'crashed'>
enum class EndReason { SourceClosed, Stopped, DeviceLost, Error };

/// HelperLogLevel
enum class LogLevel { Debug, Info, Warn, Error };

struct AdapterCaps {
  std::string name;
  std::string vendor;
  std::string luid;
};
struct EncoderCaps {
  std::string name;
  std::string vendor;
};
struct Features {
  bool borderless = false;
  bool minUpdateInterval = false;
  bool cursorToggle = false;
  bool processLoopback = false;
};
/// HelperCapabilities
struct Capabilities {
  std::string version;
  int protocol = kProtocolVersion;
  uint32_t osBuild = 0;
  std::optional<AdapterCaps> adapter;
  std::optional<EncoderCaps> encoder;
  Features features;
};

/// HelperStats
struct Stats {
  double captureFps = 0;
  double encodeFps = 0;
  uint64_t targetBitrate = 0;
  std::optional<uint64_t> sentBitrate;
  uint64_t keyframes = 0;
  uint64_t droppedFrames = 0;
  bool stalled = false;
  std::string encoder;
  uint32_t width = 0;
  uint32_t height = 0;
};

std::string_view toString(ErrorCode code);
std::string_view toString(State state);
std::string_view toString(EndReason reason);
std::string_view toString(LogLevel level);
std::string_view toString(ContentHint hint);
std::string_view toString(AudioMode mode);

nlohmann::json toJson(const Capabilities& caps);
nlohmann::json toJson(const Stats& stats);

// Each encoder returns one JSON line without the trailing newline.
std::string encodeResultOk(int64_t id, const Capabilities* capabilities = nullptr);
std::string encodeResultError(int64_t id, ErrorCode code, std::string_view message);
std::string encodeState(State state);
std::string encodeStats(const Stats& stats);
std::string encodeEnded(EndReason reason);
std::string encodeError(ErrorCode code, std::string_view message);
std::string encodeLog(LogLevel level, std::string_view message);

} // namespace nexo::ipc
