// LiveKit C++ SDK publisher (SPEC-BETA §4.8). The only translation unit that includes the SDK.
//
// API as of client-sdk-cpp v1.13.1 (native/livekit-sdk.lock), read from include/livekit/*.h:
//   EncodedVideoSource(VideoCodec, int w, int h); bool captureFrame(const Frame&) const; Feedback takeFeedback() const
//   Feedback{ bool keyframe_requested; std::optional<RateControl{uint64 target_bitrate_bps; double framerate_fps}> }
//   TrackSource::SOURCE_SCREENSHARE / SOURCE_SCREENSHARE_AUDIO
#include <livekit/livekit.h>

#include <atomic>
#include <mutex>
#include <vector>

#include "common/log.hpp"
#include "common/win_error.hpp"
#include "publish/publisher.hpp"

namespace nexo {
namespace {

std::once_flag g_initOnce;
// Same as the alpha's stream audio (livekit-client AudioPresets.musicHighQualityStereo): game audio and music
// need stereo and more than voice bitrates.
constexpr uint64_t kAudioBitrate = 128'000;
constexpr int kAudioSampleRate = 48'000;
constexpr int kAudioChannels = 2;
std::atomic<bool> g_initialized{false};

livekit::LogLevel sdkLogLevelFromEnv() {
  const auto v = envString("NEXO_MEDIA_SDK_LOG");
  if (v == "trace") return livekit::LogLevel::Trace;
  if (v == "debug") return livekit::LogLevel::Debug;
  if (v == "warn") return livekit::LogLevel::Warn;
  if (v == "error") return livekit::LogLevel::Error;
  return livekit::LogLevel::Info;
}

void ensureInitialized() {
  std::call_once(g_initOnce, [] {
    livekit::initialize(sdkLogLevelFromEnv());
    // SDK logs become our `log` events (redacted like everything else: the signalling URL can carry the token).
    livekit::setLogCallback([](livekit::LogLevel level, const std::string& logger, const std::string& message) {
      ipc::LogLevel ours = ipc::LogLevel::Info;
      if (level <= livekit::LogLevel::Debug) ours = ipc::LogLevel::Debug;
      else if (level == livekit::LogLevel::Warn) ours = ipc::LogLevel::Warn;
      else if (level >= livekit::LogLevel::Error) ours = ipc::LogLevel::Error;
      EventSink::instance().log(ours, "[" + logger + "] " + message);
    });
    g_initialized = true;
  });
}

const char* disconnectReason(livekit::DisconnectReason r) {
  using R = livekit::DisconnectReason;
  switch (r) {
    case R::ClientInitiated: return "client initiated";
    case R::DuplicateIdentity: return "another stream connected with the same identity";
    case R::ServerShutdown: return "server shutting down";
    case R::ParticipantRemoved: return "removed by the server";
    case R::RoomDeleted: return "room deleted";
    case R::StateMismatch: return "state mismatch";
    case R::JoinFailure: return "join failure";
    case R::SignalClose: return "signalling connection closed";
    case R::RoomClosed: return "room closed";
    case R::ConnectionTimeout: return "connection timeout";
    case R::MediaFailure: return "media failure";
    default: return "unknown";
  }
}

class LiveKitPublisher final : public Publisher, private livekit::RoomDelegate {
 public:
  explicit LiveKitPublisher(PublisherCallbacks callbacks) : callbacks_(std::move(callbacks)) {}
  ~LiveKitPublisher() override { close(); }

  void connect(const std::string& url, const std::string& token) override {
    ensureInitialized();
    url_ = url;
    room_ = std::make_unique<livekit::Room>();
    room_->setDelegate(this);
    livekit::RoomOptions options;
    // The stream participant only publishes; its token can't subscribe anyway (SPEC-BETA §7).
    options.auto_subscribe = false;
    options.dynacast = false;
    bool ok = false;
    std::string why;
    try {
      ok = room_->connect(url, token, options);
    } catch (const std::exception& e) {
      why = e.what();
    }
    if (!ok) {
      room_.reset();
      throw ShareError(ipc::ErrorCode::LivekitConnect,
                       "could not connect to LiveKit at " + url + (why.empty() ? "" : ": " + why));
    }
    if (auto lp = room_->localParticipant().lock()) {
      log::info("publish: connected to {} as {}", url, lp->identity());
    }
  }

  void publishVideo(const VideoTrackConfig& c) override {
    try {
      source_ = std::make_shared<livekit::EncodedVideoSource>(livekit::VideoCodec::H264, static_cast<int>(c.width),
                                                              static_cast<int>(c.height));
      track_ = livekit::LocalVideoTrack::createLocalVideoTrack("screen", source_);
      livekit::TrackPublishOptions o;
      o.source = livekit::TrackSource::SOURCE_SCREENSHARE;
      o.video_codec = livekit::VideoCodec::H264;
      o.video_encoder = livekit::VideoEncoderBackend::PreEncoded;
      o.simulcast = false;
      // Without explicit encodings the SDK picks its screen-share preset (a few Mbps at 15 fps), and the
      // encoding's max_framerate would make WebRTC drop our frames — each drop breaks the reference chain and
      // costs an IDR. So publish with the preset's own limits.
      o.video_encoding = livekit::VideoEncodingOptions{c.maxBitrate, c.fps};
      // A pass-through can't be rescaled; fps degradation is ours (SPEC-BETA §4.9).
      o.degradation_preference = livekit::DegradationPreference::MaintainResolution;
      auto lp = room_ ? room_->localParticipant().lock() : nullptr;
      if (!lp) throw std::runtime_error("not connected");
      lp->publishTrack(track_, o);
      log::info("publish: track 'screen' (ScreenShare, H.264 pre-encoded {}x{}, max {} kbps @ {} fps) sid {}", c.width,
                c.height, c.maxBitrate / 1000, c.fps, track_->sid());
    } catch (const ShareError&) {
      throw;
    } catch (const std::exception& e) {
      throw ShareError(ipc::ErrorCode::LivekitConnect, std::string("could not publish the stream track: ") + e.what());
    }
  }

  bool sendVideo(EncodedFrame&& frame) override {
    if (!source_) return false;
    livekit::EncodedVideoSource::Frame f;
    f.is_keyframe = frame.keyframe;
    f.timestamp_us = frame.timestampUs;
    f.data = std::move(frame.data);
    try {
      return source_->captureFrame(f);
    } catch (const std::exception& e) {
      if (++captureErrors_ <= 5) log::warn("publish: captureFrame failed: {}", e.what());
      return false;
    }
  }

  void publishAudio() override {
    try {
      auto lp = room_ ? room_->localParticipant().lock() : nullptr;
      if (!lp) throw std::runtime_error("not connected");
      // queue_size_ms = 0: frames go straight to WebRTC, paced by our 10 ms capture clock.
      auto source = std::make_shared<livekit::AudioSource>(kAudioSampleRate, kAudioChannels, 0);
      audioTrack_ = livekit::LocalAudioTrack::createLocalAudioTrack("screen-audio", source);
      livekit::TrackPublishOptions o;
      o.source = livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO;
      o.audio_encoding = livekit::AudioEncodingOptions{kAudioBitrate};
      o.dtx = false; // DTX chops quiet passages of game audio and music
      lp->publishTrack(audioTrack_, o);
      audioSource_.store(source);
      log::info("publish: track 'screen-audio' (ScreenShareAudio, 48 kHz stereo, {} kbps) sid {}", kAudioBitrate / 1000,
                audioTrack_->sid());
    } catch (const std::exception& e) {
      audioTrack_.reset();
      throw ShareError(ipc::ErrorCode::AudioFailed, std::string("could not publish the stream audio track: ") + e.what());
    }
  }

  bool sendAudio(std::span<const int16_t> frame) override {
    const auto source = audioSource_.load();
    if (!source || frame.empty()) return false;
    try {
      livekit::AudioFrame f(std::vector<int16_t>(frame.begin(), frame.end()), kAudioSampleRate, kAudioChannels,
                            static_cast<int>(frame.size() / kAudioChannels));
      source->captureFrame(f);
      return true;
    } catch (const std::exception& e) {
      if (++audioErrors_ <= 5) log::warn("publish: audio captureFrame failed: {}", e.what());
      return false;
    }
  }

  PublishFeedback takeFeedback() override {
    PublishFeedback out;
    if (!source_) return out;
    try {
      const auto fb = source_->takeFeedback();
      out.keyframeRequested = fb.keyframe_requested;
      if (fb.rate_control) {
        out.targetBitrateBps = fb.rate_control->target_bitrate_bps;
        out.framerateFps = fb.rate_control->framerate_fps;
      }
    } catch (const std::exception& e) {
      if (++feedbackErrors_ <= 5) log::warn("publish: takeFeedback failed: {}", e.what());
    }
    return out;
  }

  void close() override {
    std::lock_guard lock(closeMutex_);
    closing_ = true;
    if (!room_) return;
    audioSource_.store(nullptr);
    for (const auto& sid : {audioTrack_ ? audioTrack_->sid() : std::string(), track_ ? track_->sid() : std::string()}) {
      if (sid.empty()) continue;
      try {
        if (auto lp = room_->localParticipant().lock()) lp->unpublishTrack(sid);
      } catch (const std::exception& e) {
        log::warn("publish: unpublish failed: {}", e.what());
      }
    }
    try {
      room_->disconnect();
    } catch (const std::exception& e) {
      log::warn("publish: disconnect failed: {}", e.what());
    }
    room_->setDelegate(nullptr);
    room_.reset();
    track_.reset();
    source_.reset();
    audioTrack_.reset();
    log::info("publish: disconnected");
  }

  void detachCallbacks() override {
    std::lock_guard lock(callbackMutex_);
    callbacks_ = {};
  }

  std::string describe() const override { return "LiveKit " + url_; }

 private:
  // RoomDelegate (SDK event thread). Must not call Room::disconnect from here.
  void onReconnecting(livekit::Room&, const livekit::ReconnectingEvent&) override {
    log::warn("publish: connection lost, reconnecting");
    std::lock_guard lock(callbackMutex_);
    if (callbacks_.onState) callbacks_.onState(ipc::State::Reconnecting);
  }
  void onReconnected(livekit::Room&, const livekit::ReconnectedEvent&) override {
    log::info("publish: reconnected");
    std::lock_guard lock(callbackMutex_);
    if (callbacks_.onState) callbacks_.onState(ipc::State::Live);
  }
  void onDisconnected(livekit::Room&, const livekit::DisconnectedEvent& e) override {
    if (closing_) return;
    const std::string reason = disconnectReason(e.reason);
    log::warn("publish: disconnected by the server ({})", reason);
    std::lock_guard lock(callbackMutex_);
    if (callbacks_.onDisconnected) callbacks_.onDisconnected(reason);
  }

  std::mutex callbackMutex_; ///< callbacks_ against detachCallbacks()
  PublisherCallbacks callbacks_;
  std::string url_;
  std::unique_ptr<livekit::Room> room_;
  std::shared_ptr<livekit::EncodedVideoSource> source_;
  std::shared_ptr<livekit::LocalVideoTrack> track_;
  std::atomic<std::shared_ptr<livekit::AudioSource>> audioSource_; ///< read by the audio thread
  std::shared_ptr<livekit::LocalAudioTrack> audioTrack_;
  std::mutex closeMutex_;
  std::atomic<bool> closing_{false};
  int captureErrors_ = 0;
  int audioErrors_ = 0;
  std::atomic<int> feedbackErrors_{0};
};

} // namespace

std::unique_ptr<Publisher> createLiveKitPublisher(PublisherCallbacks callbacks) {
  return std::make_unique<LiveKitPublisher>(std::move(callbacks));
}

void shutdownLiveKit() {
  if (g_initialized.exchange(false)) livekit::shutdown();
}

} // namespace nexo
