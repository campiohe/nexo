#include "share/share.hpp"

#include <algorithm>
#include <format>

#include "capture/test_pattern.hpp"
#include "capture/wgc.hpp"
#include "common/log.hpp"
#include "common/win_error.hpp"
#include "sys/system_info.hpp"

namespace nexo {
namespace {

void emit(std::string_view line) {
  EventSink::instance().write(line);
}

PacerConfig pacerConfig(const ipc::Preset& preset, Size output) {
  PacerConfig c;
  c.presetFps = preset.fps;
  c.maxBitrate = preset.maxBitrate;
  c.hint = preset.contentHint;
  c.output = output;
  if (auto qp = envString("NEXO_MEDIA_DETAIL_MAX_QP"); !qp.empty()) {
    try {
      c.detailMaxQp = static_cast<uint32_t>(std::clamp(std::stoi(qp), 10, 51));
    } catch (...) {
    }
  }
  return c;
}

int envInt(const char* name, int fallback) {
  const auto v = envString(name);
  if (v.empty()) return fallback;
  try {
    return std::stoi(v);
  } catch (...) {
    return fallback;
  }
}

/// Which process loopback the share's audio mode means (SPEC-BETA §4.7 table).
std::optional<AudioCaptureConfig> resolveAudio(const ShareSpec& spec) {
  if (spec.audio == ipc::AudioMode::Off) return std::nullopt;
  if (spec.audio == ipc::AudioMode::App) {
    DWORD pid = 0;
    if (spec.kind == ShareSpec::Kind::Window) GetWindowThreadProcessId(spec.hwnd, &pid);
    if (spec.kind == ShareSpec::Kind::TestPattern) pid = spec.audioPid;
    if (pid != 0) return AudioCaptureConfig{LoopbackMode::IncludeProcessTree, pid};
    // A monitor has no owning app. Rejecting would leave the share silent for a UI that just asked for audio,
    // so it gets what a screen share gets: everything but Nexo.
    log::info("audio: 'app' on a source without a window means 'system-but-nexo'");
  }
  uint32_t exclude = spec.excludePid;
  if (exclude == 0) {
    // Without Electron's PID, exclude ourselves (we play nothing): system audio, Nexo's sounds included.
    log::warn("audio: no excludePid given, Nexo's own audio will be in the stream");
    exclude = GetCurrentProcessId();
  }
  return AudioCaptureConfig{LoopbackMode::ExcludeProcessTree, exclude};
}

std::string describeSpec(const ShareSpec& s) {
  switch (s.kind) {
    case ShareSpec::Kind::Window: return std::format("window {}", reinterpret_cast<uintptr_t>(s.hwnd));
    case ShareSpec::Kind::Monitor:
      return std::format("monitor at {},{} {}x{}", s.monitorRect.x, s.monitorRect.y, s.monitorRect.width, s.monitorRect.height);
    case ShareSpec::Kind::TestPattern: return "test pattern";
  }
  return "?";
}

/// One LiveKit session per process. Two `<user>#stream` connections with the same identity make the server
/// kick the older one, so a share whose connect was abandoned keeps the gate until that connect has returned
/// and disconnected, and the next share waits for it. A semaphore, not a mutex: the abandoned connect's thread
/// releases it, not the thread that took it.
HANDLE liveKitGate() {
  static const winrt::handle gate(CreateSemaphoreW(nullptr, 1, 1, nullptr));
  return gate.get();
}

std::shared_ptr<void> takeLiveKitGate() {
  return std::shared_ptr<void>(liveKitGate(), [](void* h) { ReleaseSemaphore(static_cast<HANDLE>(h), 1, nullptr); });
}

/// The connect thread's result, shared with a share that may have stopped waiting for it.
struct ConnectJob {
  std::mutex mutex;
  winrt::handle done{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  bool finished = false;
  bool abandoned = false;
  bool ok = false;
  ipc::ErrorCode code = ipc::ErrorCode::LivekitConnect;
  std::string error;
};

} // namespace

bool waitLiveKitIdle(std::chrono::milliseconds timeout) {
  if (WaitForSingleObject(liveKitGate(), static_cast<DWORD>(timeout.count())) != WAIT_OBJECT_0) return false;
  ReleaseSemaphore(liveKitGate(), 1, nullptr);
  return true;
}

std::unique_ptr<Share> Share::prepare(const ShareSpec& spec) {
  auto share = std::make_unique<Share>(Private{});
  share->spec_ = spec;
  log::info("share: preparing {} preset {}x{}@{} {} kbps {}{}", describeSpec(spec), spec.preset.width, spec.preset.height,
            spec.preset.fps, spec.preset.maxBitrate / 1000, ipc::toString(spec.preset.contentHint),
            spec.livekit ? "" : " (dry run)");

  if (envFlag("NEXO_MEDIA_DISABLE_HW")) {
    throw ShareError(ipc::ErrorCode::EncoderUnavailable, "hardware encoding disabled (NEXO_MEDIA_DISABLE_HW=1)");
  }

  Share* self = share.get();
  PublisherCallbacks callbacks;
  callbacks.onState = [](ipc::State state) { emit(ipc::encodeState(state)); };
  callbacks.onDisconnected = [self](const std::string& reason) {
    self->fail(ipc::ErrorCode::LivekitConnect, "LiveKit disconnected: " + reason);
  };
  if (spec.livekit) {
#if defined(NEXO_WITH_LIVEKIT)
    share->publisher_ = createLiveKitPublisher(std::move(callbacks));
#else
    throw ShareError(ipc::ErrorCode::LivekitConnect, "this build has no LiveKit SDK (NEXO_WITH_LIVEKIT=OFF)");
#endif
  } else {
    share->publisher_ = createNullPublisher(std::move(callbacks));
  }

  share->buildPipeline(true);

  share->audioConfig_ = resolveAudio(spec);
  if (spec.dumpWav && share->audioConfig_) {
    share->wav_ = std::make_unique<WavWriter>(*spec.dumpWav, WasapiCapture::kSampleRate, static_cast<uint16_t>(WasapiCapture::kChannels));
    if (!share->wav_->ok()) log::warn("share: cannot open {} for the audio dump", spec.dumpWav->string());
  }

  if (spec.dumpH264) {
    share->dump_.open(*spec.dumpH264, std::ios::binary | std::ios::trunc);
    if (!share->dump_) log::warn("share: cannot open {} for the H.264 dump", spec.dumpH264->string());
  }

  share->testDeviceLostAfterUs_ = static_cast<int64_t>(std::max(0, envInt("NEXO_MEDIA_TEST_DEVICE_LOST_AFTER_MS", 0))) * 1000;
  share->testRebuildFailures_ = std::max(0, envInt("NEXO_MEDIA_TEST_DEVICE_REBUILD_FAILS", 0));

  share->stopEvent_.attach(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!share->stopEvent_) throw ShareError(ipc::ErrorCode::Internal, "CreateEvent failed");
  log::info("share: ready, output {}x{} from {} ({}x{})", share->output_.width, share->output_.height, share->source_->describe(),
            share->source_->initialSize().width, share->source_->initialSize().height);
  return share;
}

void Share::buildPipeline(bool initial) {
  if (!initial && testRebuildFailures_ > 0) {
    --testRebuildFailures_;
    throw std::runtime_error("simulated rebuild failure (NEXO_MEDIA_TEST_DEVICE_REBUILD_FAILS)");
  }

  // Adapter: high-performance first, and it must have a hardware H.264 MFT (SPEC-BETA §4.3). Enumerated again
  // on a rebuild: after a driver restart the adapter's LUID can change.
  std::optional<AdapterDesc> adapter;
  try {
    for (const auto& a : listAdapters()) {
      if (!listH264Encoders(&a.luid).empty()) {
        adapter = a;
        break;
      }
    }
  } catch (const std::exception& e) {
    throw ShareError(ipc::ErrorCode::EncoderUnavailable, std::string("GPU enumeration failed: ") + e.what());
  }
  if (!adapter) throw ShareError(ipc::ErrorCode::EncoderUnavailable, "no GPU with a hardware H.264 encoder");

  try {
    device_ = D3DDevice::create(*adapter);
  } catch (const std::exception& e) {
    throw ShareError(ipc::ErrorCode::EncoderUnavailable, std::string("D3D11 device: ") + e.what());
  }
  winrt::com_ptr<ID3D11Device> d3d;
  d3d.copy_from(device_->device());
  ring_ = std::make_unique<FrameRing>(std::move(d3d));

  // Source
  const double fps = initial ? spec_.preset.fps : lastFps_;
  try {
    switch (spec_.kind) {
      case ShareSpec::Kind::Window:
        source_ = std::make_unique<WgcCapture>(device_, *ring_, WgcCapture::Target{spec_.hwnd, nullptr}, spec_.cursor, fps);
        break;
      case ShareSpec::Kind::Monitor: {
        // Physical coordinates: the process is per-monitor DPI aware (main.cpp), as is Electron's dipToScreenRect.
        const RECT r{spec_.monitorRect.x, spec_.monitorRect.y, spec_.monitorRect.x + spec_.monitorRect.width,
                     spec_.monitorRect.y + spec_.monitorRect.height};
        HMONITOR monitor = MonitorFromRect(&r, MONITOR_DEFAULTTONULL);
        if (!monitor) throw ShareError(ipc::ErrorCode::CaptureFailed, "no monitor at the given rectangle");
        source_ = std::make_unique<WgcCapture>(device_, *ring_, WgcCapture::Target{nullptr, monitor}, spec_.cursor, fps);
        break;
      }
      case ShareSpec::Kind::TestPattern:
        source_ = std::make_unique<TestPatternSource>(device_, *ring_, spec_.patternSize, fps);
        break;
    }
  } catch (const ShareError&) {
    throw;
  } catch (const winrt::hresult_error& e) {
    throw ShareError(ipc::ErrorCode::CaptureFailed, "capture: " + describeHresult(e.code()));
  } catch (const std::exception& e) {
    throw ShareError(ipc::ErrorCode::CaptureFailed, std::string("capture: ") + e.what());
  }

  ipc::ContentHint hint;
  EncoderConfig ec;
  {
    std::lock_guard lock(pacerMutex_);
    if (initial) {
      // Output size is fixed for the whole share (EncodedVideoSource has a fixed size, SPEC-BETA §4.4), so a
      // rebuild keeps it even if the source size changed meanwhile: the converter letterboxes.
      output_ = pickOutputSize(source_->initialSize(), {spec_.preset.width, spec_.preset.height});
      pacer_ = std::make_unique<Pacer>(pacerConfig(spec_.preset, output_));
    }
    hint = spec_.preset.contentHint;
    ec.size = output_;
    ec.fps = spec_.preset.fps;
    ec.rates = pacer_->encoderRates();
    pacer_->takeRateChange(); // the encoder starts with these rates
  }

  try {
    converter_ = std::make_unique<VideoConverter>(device_, output_, hint == ipc::ContentHint::Detail);
    converterDetail_ = hint == ipc::ContentHint::Detail;
  } catch (const std::exception& e) {
    // No GPU conversion means no native path: let the renderer fall back like for a missing encoder.
    throw ShareError(ipc::ErrorCode::EncoderUnavailable, std::string("video processor: ") + e.what());
  }

  encoder_ = createEncoder(ec.rates, ec.fps);
  lastMode_ = ec.rates.mode;
}

std::unique_ptr<MfEncoder> Share::createEncoder(const EncoderRates& rates, double fps) {
  EncoderConfig ec;
  ec.size = output_;
  ec.fps = fps;
  ec.rates = rates;
  ec.profile = h264ProfileFromEnv();
  Share* self = this;
  return MfEncoder::create(
      device_, ec, [self](EncodedFrame&& f) { self->onEncoded(std::move(f)); },
      [self, weak = std::weak_ptr<D3DDevice>(device_)](const std::string& message) {
        // A failure caused by a lost device is the encode loop's to handle (rebuild), not the end of the share.
        if (auto device = weak.lock(); device && FAILED(device->removedReason())) {
          log::warn("{} (the GPU device is lost)", message);
          return;
        }
        self->fail(ipc::ErrorCode::EncoderUnavailable, message);
      });
}

void Share::rebuildEncoder(const char* why) {
  const int64_t t0 = qpcMicros();
  EncoderRates rates;
  double fps = 0;
  {
    std::lock_guard lock(pacerMutex_);
    rates = pacer_->encoderRates();
    pacer_->takeRateChange();
    fps = spec_.preset.fps;
  }
  encoder_->shutdown();
  keyframesBase_ += encoder_->keyframes();
  encoder_.reset();
  lastOutFrames_ = 0;
  lastOutBytes_ = 0;
  // Throws ShareError(encoder-unavailable): run() turns it into the share's error.
  encoder_ = createEncoder(rates, fps);
  lastMode_ = rates.mode;
  {
    std::lock_guard lock(pacerMutex_);
    pacer_->forceKeyframe(); // a new encoder starts a new stream
  }
  log::info("encoder: recreated ({}) in {} ms: {} {} fps, mean {} kbps", why, (qpcMicros() - t0) / 1000,
            rates.mode == RateMode::Cbr ? "CBR" : "PCVBR", fps, rates.meanBitrate / 1000);
}

void Share::teardownPipeline() {
  // Same order as teardown(): nothing pushes into the ring or the encoder while they go away.
  if (source_) source_->stop();
  if (encoder_) {
    encoder_->shutdown();
    keyframesBase_ += encoder_->keyframes();
  }
  encoder_.reset();
  converter_.reset();
  source_.reset();
  ring_.reset();
  device_.reset();
  // The next ring and encoder count from zero again.
  lastPushed_ = 0;
  lastOutFrames_ = 0;
  lastOutBytes_ = 0;
}

bool Share::deviceLost() const {
  return device_ && FAILED(device_->removedReason());
}

Share::Recovery Share::recoverDevice(HRESULT reason) {
  const int64_t t0 = qpcMicros();
  log::error("share: GPU device lost ({}), rebuilding the pipeline; the track stays published", describeHresult(reason));
  if (!lossPolicy_.onLoss(t0)) {
    log::error("share: the GPU device was lost {} times within a minute, giving up", lossPolicy_.losses());
    endWith(ipc::EndReason::DeviceLost);
    return Recovery::Ended;
  }
  for (;;) {
    try {
      teardownPipeline();
      buildPipeline(false);
      source_->start();
      {
        std::lock_guard lock(pacerMutex_);
        pacer_->forceKeyframe(); // a new encoder, a new stream: viewers need an IDR before anything else
      }
      const int attempt = lossPolicy_.attempts() + 1;
      lossPolicy_.onRebuilt();
      log::info("share: pipeline rebuilt on {} in {} ms (attempt {})", device_->adapter().name, (qpcMicros() - t0) / 1000,
                attempt);
      return Recovery::Recovered;
    } catch (const std::exception& e) {
      log::error("share: rebuild after device loss failed: {}", e.what());
      const auto delay = lossPolicy_.onRebuildFailed();
      if (!delay) {
        log::error("share: the rebuild failed twice, ending the share (device-lost)");
        endWith(ipc::EndReason::DeviceLost);
        return Recovery::Ended;
      }
      if (WaitForSingleObject(stopEvent_.get(), static_cast<DWORD>(*delay / 1000)) == WAIT_OBJECT_0) return Recovery::Ended;
    }
  }
}

Share::~Share() {
  requestStop();
  if (thread_.joinable()) thread_.join();
}

void Share::start() {
  thread_ = std::thread([this] { run(); });
}

void Share::endWith(ipc::EndReason reason) {
  {
    std::lock_guard lock(endMutex_);
    if (endReason_) return; // first reason wins
    endReason_ = reason;
  }
  if (stopEvent_) SetEvent(stopEvent_.get());
}

bool Share::ending() const {
  std::lock_guard lock(endMutex_);
  return endReason_.has_value();
}

void Share::fail(ipc::ErrorCode code, const std::string& message, ipc::EndReason reason) {
  if (ending()) return; // already ending: one error per share is enough
  log::error("share: {}", message);
  emit(ipc::encodeError(code, message));
  endWith(reason);
}

void Share::requestStop() {
  endWith(ipc::EndReason::Stopped);
}

ipc::EndReason Share::endReason() const {
  std::lock_guard lock(endMutex_);
  return endReason_.value_or(ipc::EndReason::Stopped);
}

bool Share::waitFinished(std::chrono::milliseconds timeout) {
  std::unique_lock lock(finishedMutex_);
  return finishedCv_.wait_for(lock, timeout, [this] { return finished_.load(); });
}

void Share::update(const std::optional<ipc::PresetPatch>& patch, std::optional<bool> cursor) {
  if (patch) {
    std::lock_guard lock(pacerMutex_);
    auto& p = spec_.preset;
    if ((patch->width && *patch->width != p.width) || (patch->height && *patch->height != p.height)) {
      throw ShareError(ipc::ErrorCode::Protocol, "the output size is fixed for a share: stop and start again");
    }
    if (patch->fps) p.fps = *patch->fps;
    if (patch->maxBitrate) p.maxBitrate = *patch->maxBitrate;
    if (patch->contentHint) p.contentHint = *patch->contentHint;
    // The encode thread picks the new rates (and the converter's scaler for the hint) up on its next tick.
    pacer_->reconfigure(pacerConfig(p, output_));
    log::info("share: preset updated to {} fps, {} kbps, {}", p.fps, p.maxBitrate / 1000, ipc::toString(p.contentHint));
  }
  // The encode thread owns source_ (it replaces it after a device loss), so it applies the change.
  if (cursor) pendingCursor_.store(*cursor ? 1 : 0);
}

void Share::onEncoded(EncodedFrame&& frame) {
  if (dump_.is_open()) {
    std::lock_guard lock(dumpMutex_);
    dump_.write(reinterpret_cast<const char*>(frame.data.data()), static_cast<std::streamsize>(frame.data.size()));
  }
  if (!publisher_->sendVideo(std::move(frame))) rejected_.fetch_add(1);
}

bool Share::connectPublisher() {
  // 1. The gate: wait for any previous (abandoned) session to be gone, unless we're stopped first.
  const int64_t t0 = qpcMicros();
  const HANDLE gate[] = {stopEvent_.get(), liveKitGate()};
  if (WaitForMultipleObjects(2, gate, FALSE, INFINITE) == WAIT_OBJECT_0) return false;
  liveKitTicket_ = takeLiveKitGate();
  if (const auto waited = (qpcMicros() - t0) / 1000; waited > 50) {
    log::info("share: waited {} ms for the previous LiveKit session to close", waited);
  }

  // 2. Connect on its own thread: Room::connect can block for ~30 s against an unreachable server and has no
  // cancel, and a `stop` must not wait for that.
  auto job = std::make_shared<ConnectJob>();
  std::string url = spec_.livekit ? spec_.livekit->url : std::string();
  std::string token = spec_.livekit ? spec_.livekit->token : std::string();
  std::thread([job, publisher = publisher_, ticket = liveKitTicket_, url = std::move(url), token = std::move(token)] {
    SetThreadDescription(GetCurrentThread(), L"nexo connect");
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    bool ok = false;
    ipc::ErrorCode code = ipc::ErrorCode::LivekitConnect;
    std::string error;
    try {
      publisher->connect(url, token);
      ok = true;
    } catch (const ShareError& e) {
      code = e.code();
      error = e.what();
    } catch (const std::exception& e) {
      error = e.what();
    }
    bool abandoned = false;
    {
      std::lock_guard lock(job->mutex);
      job->finished = true;
      job->ok = ok;
      job->code = code;
      job->error = std::move(error);
      abandoned = job->abandoned;
    }
    SetEvent(job->done.get());
    if (abandoned) {
      // Nobody is waiting: leave the room (if we got in) before the gate opens for the next share.
      log::info("share: the abandoned LiveKit connect returned ({}), closing it", ok ? "connected" : "failed");
      publisher->close();
    }
    winrt::uninit_apartment();
    // `ticket` is released here, after close(): the next share connects only now.
  }).detach();

  const HANDLE waits[] = {stopEvent_.get(), job->done.get()};
  WaitForMultipleObjects(2, waits, FALSE, INFINITE);
  std::lock_guard lock(job->mutex);
  if (!job->finished) {
    // Stopped while connecting: hand the publisher (and the gate) to the connect thread and end now.
    job->abandoned = true;
    publisher_->detachCallbacks();
    publisher_.reset();
    liveKitTicket_.reset();
    log::info("share: stopped during the LiveKit connect; the connect is abandoned");
    return false;
  }
  if (!job->ok) {
    fail(job->code, job->error);
    return false;
  }
  return !ending();
}

void Share::run() {
  SetThreadDescription(GetCurrentThread(), L"nexo share");
  winrt::init_apartment(winrt::apartment_type::multi_threaded);
  emit(ipc::encodeState(ipc::State::Connecting));
  bool published = false;
  if (connectPublisher()) {
    try {
      VideoTrackConfig track;
      track.width = output_.width;
      track.height = output_.height;
      track.fps = spec_.preset.fps;
      track.maxBitrate = spec_.preset.maxBitrate;
      track.hint = spec_.preset.contentHint;
      publisher_->publishVideo(track);
      published = true;
    } catch (const ShareError& e) {
      fail(e.code(), e.what());
    } catch (const std::exception& e) {
      fail(ipc::ErrorCode::Internal, e.what());
    }
  }

  if (published && !ending()) {
    emit(ipc::encodeState(ipc::State::Live));
    try {
      source_->start();
      startAudio();
      encodeLoop();
    } catch (const ShareError& e) {
      fail(e.code(), e.what());
    } catch (const winrt::hresult_error& e) {
      fail(ipc::ErrorCode::CaptureFailed, "capture: " + describeHresult(e.code()));
    } catch (const std::exception& e) {
      fail(ipc::ErrorCode::Internal, e.what());
    }
  }

  teardown();
  const auto reason = endReason();
  log::info("share: ended ({}), {} keyframes, {} dropped, {} encoder-busy, {} pool-empty, {} rejected by the SDK, {} device losses",
            ipc::toString(reason), keyframesBase_, dropped_, busy_, poolEmpty_, rejected_.load(), lossPolicy_.losses());
  emit(ipc::encodeState(ipc::State::Stopped));
  emit(ipc::encodeEnded(reason));
  {
    std::lock_guard lock(finishedMutex_);
    finished_ = true;
  }
  finishedCv_.notify_all();
  winrt::uninit_apartment();
}

void Share::teardown() {
  // Order matters: no new frames, then no new encoder output or audio, then the publisher they went to.
  if (audio_) audio_->stop();
  teardownPipeline();
  if (publisher_) publisher_->close();
  liveKitTicket_.reset();
  if (dump_.is_open()) dump_.close();
  if (wav_) wav_->close();
}

void Share::audioFailed(const std::string& message) {
  // Audio is an extra: the video keeps going and the share doesn't end (SPEC-BETA §4.7, protocol `error`).
  if (audioFailed_.exchange(true)) return;
  log::error("share: stream audio failed: {}", message);
  emit(ipc::encodeError(ipc::ErrorCode::AudioFailed, message));
}

void Share::startAudio() {
  if (!audioConfig_) return;
  if (!WasapiCapture::supported(osBuildNumber())) {
    audioFailed("stream audio needs Windows 10 2004 or later (process loopback, build 19041+)");
    return;
  }
  try {
    const auto t0 = qpcMicros();
    auto capture = std::make_unique<WasapiCapture>(*audioConfig_);
    // Open before publishing, so a capture that can't start doesn't leave a silent track behind.
    capture->open();
    publisher_->publishAudio();
    capture->start(
        [this](std::span<const int16_t> frame) {
          if (wav_) wav_->write(frame);
          publisher_->sendAudio(frame);
        },
        [this](const std::string& message) { audioFailed("stream audio stopped: " + message); });
    audio_ = std::move(capture);
    log::info("share: stream audio started in {} ms ({})", (qpcMicros() - t0) / 1000, audio_->describe());
  } catch (const ShareError& e) {
    audioFailed(e.what());
  } catch (const std::exception& e) {
    audioFailed(std::string("stream audio: ") + e.what());
  }
}

void Share::handleFeedback(int64_t nowUs) {
  const auto fb = publisher_->takeFeedback();
  std::optional<EncoderRates> change;
  double fps = 0;
  double presetFps = 0;
  uint64_t target = 0;
  bool detail = false;
  {
    std::lock_guard lock(pacerMutex_);
    if (fb.keyframeRequested) pacer_->requestKeyframe();
    if (fb.targetBitrateBps || fb.framerateFps) pacer_->onRateControl(fb.targetBitrateBps.value_or(0), fb.framerateFps.value_or(0));
    change = pacer_->takeRateChange();
    fps = pacer_->fps();
    target = pacer_->targetBitrate();
    detail = pacer_->config().hint == ipc::ContentHint::Detail;
    presetFps = pacer_->config().presetFps;
  }
  if (fb.keyframeRequested) {
    keyframeRequests_.fetch_add(1);
    log::info("feedback: keyframe requested (#{})", keyframeRequests_.load());
  }
  if (fb.targetBitrateBps) {
    const double delta = lastLoggedTarget_ ? std::abs(double(*fb.targetBitrateBps) - double(lastLoggedTarget_)) / double(lastLoggedTarget_) : 1.0;
    if (delta > 0.05) {
      lastLoggedTarget_ = *fb.targetBitrateBps;
      log::info("feedback: rate control target {} kbps @ {:.1f} fps -> encoder target {} kbps, {} fps", *fb.targetBitrateBps / 1000,
                fb.framerateFps.value_or(0), target / 1000, fps);
    }
  }
  const char* recreate = nullptr;
  if (change) {
    const bool modeChange = lastMode_ != change->mode;
    if (modeChange) {
      log::info("encoder: rate control {} -> {} (mean {} kbps, peak {} kbps{})",
                lastMode_ == RateMode::Cbr ? "CBR" : "PCVBR", change->mode == RateMode::Cbr ? "CBR" : "PCVBR",
                change->meanBitrate / 1000, change->peakBitrate / 1000,
                change->maxQp ? std::format(", max QP {}", *change->maxQp) : std::string());
      lastMode_ = change->mode;
    }
    if (!encoder_->setRates(*change) && modeChange) recreate = "the MFT kept its rate-control mode";
    log::debug("encoder: rates {} mean {} kbps peak {} kbps", change->mode == RateMode::Cbr ? "CBR" : "PCVBR",
               change->meanBitrate / 1000, change->peakBitrate / 1000);
  }
  // The MFT's media type carries the frame rate it budgets bits for; a preset fps change needs a new type.
  if (!recreate && presetFps != encoder_->fps()) recreate = "preset frame rate changed";
  if (recreate) rebuildEncoder(recreate);
  if (detail != converterDetail_) {
    // motion ↔ detail mid-share: the converter's scaler follows the hint (SPEC-BETA §4.9).
    converter_->setDetail(detail);
    converterDetail_ = detail;
  }
  if (const int cursor = pendingCursor_.exchange(-1); cursor >= 0) {
    spec_.cursor = cursor == 1; // a rebuilt source starts with it too
    source_->setCursor(spec_.cursor);
  }
  if (fps != lastFps_) {
    if (lastFps_ != 0) log::info("pacer: encode rate {} -> {} fps", lastFps_, fps);
    lastFps_ = fps;
    source_->setFrameRate(fps);
  }
  (void)nowUs;
}

void Share::emitStats(int64_t nowUs) {
  const double dt = lastStatsUs_ ? double(nowUs - lastStatsUs_) / 1e6 : 1.0;
  lastStatsUs_ = nowUs;
  const uint64_t pushed = ring_->pushed();
  const uint64_t outFrames = encoder_->outputFrames();
  const uint64_t outBytes = encoder_->outputBytes();
  ipc::Stats s;
  s.captureFps = double(pushed - lastPushed_) / dt;
  s.encodeFps = double(outFrames - lastOutFrames_) / dt;
  s.sentBitrate = static_cast<uint64_t>(double(outBytes - lastOutBytes_) * 8.0 / dt);
  lastPushed_ = pushed;
  lastOutFrames_ = outFrames;
  lastOutBytes_ = outBytes;
  {
    std::lock_guard lock(pacerMutex_);
    s.targetBitrate = pacer_->targetBitrate();
  }
  s.keyframes = keyframesBase_ + encoder_->keyframes();
  s.droppedFrames = dropped_;
  s.stalled = source_->stalled(nowUs);
  s.encoder = encoder_->name();
  s.width = output_.width;
  s.height = output_.height;
  emit(ipc::encodeStats(s));
}

void Share::encodeLoop() {
  SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL);
  winrt::handle timer(CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS));
  if (!timer) throw std::runtime_error("CreateWaitableTimerExW failed");

  // Frames are encoded when they arrive, not on a fixed grid: a grid free-running next to DWM's (or the test
  // pattern's) 60 Hz clock drifts against it and supersedes frames. The rate cap is a GCRA: an encode is
  // allowed once now >= tat - tolerance, then tat = max(tat, now) + interval. That keeps the long-run rate at
  // the pacer's fps while absorbing capture jitter, and holds a too-early frame until it is allowed.
  constexpr int64_t kPollUs = 20'000; // feedback, idle refresh and keyframe checks while nothing arrives
  uint64_t lastSeq = 0;
  int64_t lastTs = 0;
  int64_t tat = 0;
  int64_t retryAt = 0; // back-off after the encoder said busy, so a pending frame doesn't spin the loop
  int64_t now = qpcMicros();
  const int64_t testLossAt = testDeviceLostAfterUs_ > 0 ? now + testDeviceLostAfterUs_ : 0;
  statsAtUs_ = now + 1'000'000;
  lastStatsUs_ = now;
  lastFps_ = spec_.preset.fps;

  // After a rebuild the ring counts from 1 again; the next frame is new whatever its sequence number.
  auto recover = [&](HRESULT reason) {
    if (recoverDevice(reason) == Recovery::Ended) return false;
    lastSeq = 0;
    retryAt = 0;
    return true;
  };

  for (;;) {
    int64_t interval = 0;
    {
      std::lock_guard lock(pacerMutex_);
      interval = pacer_->tickIntervalUs();
    }
    const int64_t tolerance = interval / 2;
    now = qpcMicros();
    const auto pendingSeq = ring_->pushed(); // cheap "is there something newer" check
    const bool framePending = pendingSeq != 0 && ring_->lastPushUs() != 0 && lastSeq < pendingSeq;
    int64_t wakeAt = framePending ? std::max({now, tat - tolerance, retryAt}) : now + kPollUs;
    wakeAt = std::min(wakeAt, statsAtUs_);
    if (wakeAt > now) {
      LARGE_INTEGER due;
      due.QuadPart = -(wakeAt - now) * 10;
      SetWaitableTimer(timer.get(), &due, 0, nullptr, nullptr, FALSE);
      // A pending-but-early frame only waits for its slot; otherwise a new frame wakes us immediately.
      const HANDLE handles[] = {stopEvent_.get(), timer.get(), ring_->frameEvent()};
      const DWORD count = framePending ? 2 : 3;
      if (WaitForMultipleObjects(count, handles, FALSE, 2000) == WAIT_OBJECT_0) break;
    } else if (WaitForSingleObject(stopEvent_.get(), 0) == WAIT_OBJECT_0) {
      break;
    }
    now = qpcMicros();

    if (source_->closed()) {
      log::info("share: the source was closed");
      endWith(ipc::EndReason::SourceClosed);
      break;
    }
    if (spec_.kind == ShareSpec::Kind::Window && !IsWindow(spec_.hwnd)) {
      log::info("share: the window is gone");
      endWith(ipc::EndReason::SourceClosed);
      break;
    }
    if (testLossAt && now >= testLossAt && lossPolicy_.losses() == 0) {
      log::warn("share: simulating a GPU device loss (NEXO_MEDIA_TEST_DEVICE_LOST_AFTER_MS)");
      device_->simulateRemoval();
    }
    if (const HRESULT removed = device_->removedReason(); FAILED(removed)) {
      if (!recover(removed)) break;
      continue;
    }

    handleFeedback(now);

    if (now >= tat - tolerance) {
      auto frame = ring_->acquire();
      const bool isNew = frame && frame->seq != lastSeq;
      Pacer::Decision decision;
      {
        std::lock_guard lock(pacerMutex_);
        decision = pacer_->onTick(now, isNew, frame.has_value());
      }
      // A minimized window repeats nothing (SPEC-BETA §4.4), but a keyframe request is still answered so a
      // viewer joining now gets the last picture.
      if (decision.encode && decision.repeat && !decision.keyframe && source_->stalled(now)) decision.encode = false;
      if (!decision.encode) {
        if (frame) ring_->release();
      } else {
        MfEncoder::Submit submit = MfEncoder::Submit::Failed;
        int64_t ts = 0;
        std::optional<MfEncoder::Input> input;
        try {
          input = encoder_->allocateInput();
          if (input) {
            converter_->convert(frame->texture, frame->size, input->texture.get(), input->slice);
            ts = isNew ? frame->timestampUs : now;
            ts = std::max(ts, lastTs + 1); // encoder and RTP want increasing timestamps; repeats use "now"
          }
        } catch (const std::exception&) {
          ring_->release();
          if (!deviceLost()) throw;
          if (!recover(device_->removedReason())) break;
          continue;
        }
        ring_->release();
        if (!input) {
          ++poolEmpty_; // every input surface is still inside the encoder: retry shortly
          retryAt = now + 1'000;
        } else {
          submit = encoder_->encode(*input, ts, decision.keyframe);
          if (submit == MfEncoder::Submit::Accepted) {
            lastTs = ts;
            tat = std::max(tat, now) + interval;
            {
              std::lock_guard lock(pacerMutex_);
              pacer_->onSubmitted(now, decision.keyframe);
            }
            if (isNew) {
              if (lastSeq != 0 && frame->seq > lastSeq + 1) dropped_ += frame->seq - lastSeq - 1; // superseded
              lastSeq = frame->seq;
            }
          } else if (submit == MfEncoder::Submit::Busy) {
            ++busy_; // the frame stays "new" and is retried (or superseded) shortly
            retryAt = now + 1'000;
          } else if (deviceLost()) {
            if (!recover(device_->removedReason())) break;
            continue;
          } else {
            break; // the encoder reported the failure through fail()
          }
        }
      }
    }

    if (now >= statsAtUs_) {
      statsAtUs_ += 1'000'000;
      if (statsAtUs_ < now) statsAtUs_ = now + 1'000'000;
      emitStats(now);
    }
  }
}

} // namespace nexo
