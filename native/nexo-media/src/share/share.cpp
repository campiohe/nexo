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

std::string describeSpec(const ShareSpec& s) {
  switch (s.kind) {
    case ShareSpec::Kind::Window: return std::format("window {}", reinterpret_cast<uintptr_t>(s.hwnd));
    case ShareSpec::Kind::Monitor:
      return std::format("monitor at {},{} {}x{}", s.monitorRect.x, s.monitorRect.y, s.monitorRect.width, s.monitorRect.height);
    case ShareSpec::Kind::TestPattern: return "test pattern";
  }
  return "?";
}

} // namespace

std::unique_ptr<Share> Share::prepare(const ShareSpec& spec) {
  auto share = std::make_unique<Share>(Private{});
  share->spec_ = spec;
  log::info("share: preparing {} preset {}x{}@{} {} kbps {}{}", describeSpec(spec), spec.preset.width, spec.preset.height,
            spec.preset.fps, spec.preset.maxBitrate / 1000, ipc::toString(spec.preset.contentHint),
            spec.livekit ? "" : " (dry run)");

  if (envFlag("NEXO_MEDIA_DISABLE_HW")) {
    throw ShareError(ipc::ErrorCode::EncoderUnavailable, "hardware encoding disabled (NEXO_MEDIA_DISABLE_HW=1)");
  }

  // Adapter: high-performance first, and it must have a hardware H.264 MFT (SPEC-BETA §4.3).
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
    share->device_ = D3DDevice::create(*adapter);
  } catch (const std::exception& e) {
    throw ShareError(ipc::ErrorCode::EncoderUnavailable, std::string("D3D11 device: ") + e.what());
  }
  winrt::com_ptr<ID3D11Device> d3d;
  d3d.copy_from(share->device_->device());
  share->ring_ = std::make_unique<FrameRing>(std::move(d3d));

  // Source
  try {
    switch (spec.kind) {
      case ShareSpec::Kind::Window: {
        share->source_ = std::make_unique<WgcCapture>(share->device_, *share->ring_, WgcCapture::Target{spec.hwnd, nullptr},
                                                      spec.cursor, spec.preset.fps);
        break;
      }
      case ShareSpec::Kind::Monitor: {
        // Physical coordinates: the process is per-monitor DPI aware (main.cpp), as is Electron's dipToScreenRect.
        const RECT r{spec.monitorRect.x, spec.monitorRect.y, spec.monitorRect.x + spec.monitorRect.width,
                     spec.monitorRect.y + spec.monitorRect.height};
        HMONITOR monitor = MonitorFromRect(&r, MONITOR_DEFAULTTONULL);
        if (!monitor) throw ShareError(ipc::ErrorCode::CaptureFailed, "no monitor at the given rectangle");
        share->source_ = std::make_unique<WgcCapture>(share->device_, *share->ring_, WgcCapture::Target{nullptr, monitor},
                                                      spec.cursor, spec.preset.fps);
        break;
      }
      case ShareSpec::Kind::TestPattern:
        share->source_ = std::make_unique<TestPatternSource>(share->device_, *share->ring_, spec.patternSize, spec.preset.fps);
        break;
    }
  } catch (const ShareError&) {
    throw;
  } catch (const winrt::hresult_error& e) {
    throw ShareError(ipc::ErrorCode::CaptureFailed, "capture: " + describeHresult(e.code()));
  } catch (const std::exception& e) {
    throw ShareError(ipc::ErrorCode::CaptureFailed, std::string("capture: ") + e.what());
  }

  // Output size is fixed for the whole share (EncodedVideoSource has a fixed size, SPEC-BETA §4.4).
  share->output_ = pickOutputSize(share->source_->initialSize(), {spec.preset.width, spec.preset.height});
  share->pacer_ = std::make_unique<Pacer>(pacerConfig(spec.preset, share->output_));

  try {
    share->converter_ = std::make_unique<VideoConverter>(share->device_, share->output_,
                                                          spec.preset.contentHint == ipc::ContentHint::Detail);
  } catch (const std::exception& e) {
    // No GPU conversion means no native path: let the renderer fall back like for a missing encoder.
    throw ShareError(ipc::ErrorCode::EncoderUnavailable, std::string("video processor: ") + e.what());
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

  EncoderConfig ec;
  ec.size = share->output_;
  ec.fps = spec.preset.fps;
  ec.rates = share->pacer_->encoderRates();
  ec.profile = h264ProfileFromEnv();
  share->encoder_ = MfEncoder::create(
      share->device_, ec, [self](EncodedFrame&& f) { self->onEncoded(std::move(f)); },
      [self](const std::string& message) { self->fail(ipc::ErrorCode::EncoderUnavailable, message); });
  share->pacer_->takeRateChange(); // the encoder starts with these rates

  if (spec.dumpH264) {
    share->dump_.open(*spec.dumpH264, std::ios::binary | std::ios::trunc);
    if (!share->dump_) log::warn("share: cannot open {} for the H.264 dump", spec.dumpH264->string());
  }

  share->stopEvent_.attach(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!share->stopEvent_) throw ShareError(ipc::ErrorCode::Internal, "CreateEvent failed");
  log::info("share: ready, output {}x{} from {} ({}x{})", share->output_.width, share->output_.height, share->source_->describe(),
            share->source_->initialSize().width, share->source_->initialSize().height);
  return share;
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

void Share::fail(ipc::ErrorCode code, const std::string& message, ipc::EndReason reason) {
  {
    std::lock_guard lock(endMutex_);
    if (endReason_) return; // already ending: one error per share is enough
  }
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
    pacer_->reconfigure(pacerConfig(p, output_));
    log::info("share: preset updated to {} fps, {} kbps, {}", p.fps, p.maxBitrate / 1000, ipc::toString(p.contentHint));
  }
  if (cursor) source_->setCursor(*cursor);
}

void Share::onEncoded(EncodedFrame&& frame) {
  if (dump_.is_open()) {
    std::lock_guard lock(dumpMutex_);
    dump_.write(reinterpret_cast<const char*>(frame.data.data()), static_cast<std::streamsize>(frame.data.size()));
  }
  if (!publisher_->sendVideo(std::move(frame))) rejected_.fetch_add(1);
}

void Share::run() {
  SetThreadDescription(GetCurrentThread(), L"nexo share");
  winrt::init_apartment(winrt::apartment_type::multi_threaded);
  emit(ipc::encodeState(ipc::State::Connecting));
  bool connected = false;
  try {
    if (spec_.livekit) publisher_->connect(spec_.livekit->url, spec_.livekit->token);
    else publisher_->connect({}, {});
    connected = true;
    VideoTrackConfig track;
    track.width = output_.width;
    track.height = output_.height;
    track.fps = spec_.preset.fps;
    track.maxBitrate = spec_.preset.maxBitrate;
    track.hint = spec_.preset.contentHint;
    publisher_->publishVideo(track);
  } catch (const ShareError& e) {
    fail(e.code(), e.what());
  } catch (const std::exception& e) {
    fail(connected ? ipc::ErrorCode::Internal : ipc::ErrorCode::LivekitConnect, e.what());
  }

  bool stoppedEarly = false;
  {
    std::lock_guard lock(endMutex_);
    stoppedEarly = endReason_.has_value();
  }
  if (!stoppedEarly) {
    emit(ipc::encodeState(ipc::State::Live));
    try {
      source_->start();
      encodeLoop();
    } catch (const winrt::hresult_error& e) {
      fail(ipc::ErrorCode::CaptureFailed, "capture: " + describeHresult(e.code()));
    } catch (const std::exception& e) {
      fail(ipc::ErrorCode::Internal, e.what());
    }
  }

  teardown();
  const auto reason = endReason();
  log::info("share: ended ({}), {} keyframes, {} dropped, {} encoder-busy, {} pool-empty, {} rejected by the SDK",
            ipc::toString(reason), encoder_ ? encoder_->keyframes() : 0, dropped_, busy_, poolEmpty_, rejected_.load());
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
  // Order matters: no new frames, then no new encoder output, then the publisher the output went to.
  if (source_) source_->stop();
  if (encoder_) encoder_->shutdown();
  if (publisher_) publisher_->close();
  if (dump_.is_open()) dump_.close();
}

void Share::handleFeedback(int64_t nowUs) {
  const auto fb = publisher_->takeFeedback();
  std::optional<EncoderRates> change;
  double fps = 0;
  uint64_t target = 0;
  {
    std::lock_guard lock(pacerMutex_);
    if (fb.keyframeRequested) pacer_->requestKeyframe();
    if (fb.targetBitrateBps || fb.framerateFps) pacer_->onRateControl(fb.targetBitrateBps.value_or(0), fb.framerateFps.value_or(0));
    change = pacer_->takeRateChange();
    fps = pacer_->fps();
    target = pacer_->targetBitrate();
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
  if (change) {
    encoder_->setRates(*change);
    log::debug("encoder: rates {} mean {} kbps peak {} kbps", change->mode == RateMode::Cbr ? "CBR" : "PCVBR",
               change->meanBitrate / 1000, change->peakBitrate / 1000);
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
  s.keyframes = encoder_->keyframes();
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
  statsAtUs_ = now + 1'000'000;
  lastStatsUs_ = now;
  lastFps_ = spec_.preset.fps;

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
    if (const HRESULT removed = device_->removedReason(); FAILED(removed)) {
      // Rebuilding the device while keeping the track published is M3 (SPEC-BETA §4.3).
      log::error("share: GPU device lost: {}", describeHresult(removed));
      endWith(ipc::EndReason::DeviceLost);
      break;
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
      } else if (auto input = encoder_->allocateInput(); !input) {
        ring_->release();
        ++poolEmpty_; // every input surface is still inside the encoder: retry shortly
        retryAt = now + 1'000;
      } else {
        try {
          converter_->convert(frame->texture, frame->size, input->texture.get(), input->slice);
        } catch (...) {
          ring_->release();
          throw;
        }
        ring_->release();
        int64_t ts = isNew ? frame->timestampUs : now;
        ts = std::max(ts, lastTs + 1); // encoder and RTP want increasing timestamps; repeats use "now"
        const auto submit = encoder_->encode(*input, ts, decision.keyframe);
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
        } else {
          break; // the encoder reported the failure through fail()
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
