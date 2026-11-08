#include "audio/wasapi_capture.hpp"

#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <avrt.h>
#include <mmdeviceapi.h>

#include <format>
#include <vector>

#include "audio/audio_framer.hpp"
#include "capture/frame_ring.hpp" // qpcMicros
#include "common/log.hpp"
#include "common/win_error.hpp"

namespace nexo {
namespace {

// Activation normally completes in a few ms; a hung audio service must not hang the share.
constexpr DWORD kActivateTimeoutMs = 5000;
// Engine buffer. Capture is event-driven and drained on every event, so this only bounds how long the thread
// may be descheduled before WASAPI drops audio, not the latency.
constexpr REFERENCE_TIME kBufferDuration = 1'000'000; // 100 ms in 100 ns units
// Wake at least this often without an event, so the silence clock keeps its 10 ms cadence. A high-resolution
// waitable timer: a plain wait timeout rounds up to the 15.6 ms system tick.
constexpr LONG kWakeMs = 5;

/// ActivateAudioInterfaceAsync's completion handler. winrt::implements makes it agile (IAgileObject), which
/// the API requires; it runs on an MTA worker thread.
struct ActivationHandler : winrt::implements<ActivationHandler, IActivateAudioInterfaceCompletionHandler> {
  winrt::handle done{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  HRESULT result = E_PENDING;
  winrt::com_ptr<IAudioClient> client;

  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) noexcept override {
    HRESULT activateHr = E_FAIL;
    winrt::com_ptr<::IUnknown> unknown;
    HRESULT hr = operation->GetActivateResult(&activateHr, unknown.put());
    if (SUCCEEDED(hr)) hr = activateHr;
    if (SUCCEEDED(hr) && unknown) hr = unknown->QueryInterface(IID_PPV_ARGS(client.put()));
    result = hr;
    SetEvent(done.get());
    return S_OK;
  }
};

[[noreturn]] void audioFailed(const std::string& what, HRESULT hr) {
  throw ShareError(ipc::ErrorCode::AudioFailed, what + ": " + describeHresult(hr));
}

} // namespace

WasapiCapture::WasapiCapture(AudioCaptureConfig config)
    : config_(config), sampleEvent_(CreateEventW(nullptr, FALSE, FALSE, nullptr)),
      stopEvent_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {
  if (!sampleEvent_ || !stopEvent_) throw ShareError(ipc::ErrorCode::AudioFailed, "CreateEvent failed");
}

WasapiCapture::~WasapiCapture() {
  stop();
}

std::string WasapiCapture::describe() const {
  return std::format("process loopback {} pid {}", config_.mode == LoopbackMode::IncludeProcessTree ? "including" : "excluding",
                     config_.pid);
}

void WasapiCapture::open() {
  AUDIOCLIENT_ACTIVATION_PARAMS params{};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = config_.pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = config_.mode == LoopbackMode::IncludeProcessTree
                                                         ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
                                                         : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
  PROPVARIANT activation{};
  activation.vt = VT_BLOB;
  activation.blob.cbSize = sizeof(params);
  activation.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  auto handler = winrt::make_self<ActivationHandler>();
  winrt::com_ptr<IActivateAudioInterfaceAsyncOperation> operation;
  HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &activation,
                                           handler.get(), operation.put());
  if (FAILED(hr)) audioFailed("ActivateAudioInterfaceAsync (" + describe() + ")", hr);
  if (WaitForSingleObject(handler->done.get(), kActivateTimeoutMs) != WAIT_OBJECT_0) {
    throw ShareError(ipc::ErrorCode::AudioFailed, "process loopback activation timed out (" + describe() + ")");
  }
  if (FAILED(handler->result)) audioFailed("process loopback activation (" + describe() + ")", handler->result);
  client_ = handler->client;

  // Process loopback has no mix format (GetMixFormat is E_NOTIMPL): we name ours and the engine converts.
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = static_cast<WORD>(kChannels);
  format.nSamplesPerSec = kSampleRate;
  format.wBitsPerSample = 16;
  format.nBlockAlign = static_cast<WORD>(format.nChannels * format.wBitsPerSample / 8);
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  hr = client_->Initialize(AUDCLNT_SHAREMODE_SHARED,
                           AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                               AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                           kBufferDuration, 0, &format, nullptr);
  if (FAILED(hr)) audioFailed("IAudioClient::Initialize (48 kHz stereo int16)", hr);
  hr = client_->SetEventHandle(sampleEvent_.get());
  if (FAILED(hr)) audioFailed("IAudioClient::SetEventHandle", hr);
  hr = client_->GetService(IID_PPV_ARGS(capture_.put()));
  if (FAILED(hr)) audioFailed("IAudioClient::GetService(IAudioCaptureClient)", hr);
  log::info("audio: {} opened (48 kHz stereo int16)", describe());
}

void WasapiCapture::start(FrameFn onFrame, ErrorFn onError) {
  if (!client_ || thread_.joinable()) return;
  ResetEvent(stopEvent_.get());
  const HRESULT hr = client_->Start();
  if (FAILED(hr)) audioFailed("IAudioClient::Start", hr);
  thread_ = std::thread([this, onFrame = std::move(onFrame), onError = std::move(onError)]() mutable {
    run(std::move(onFrame), std::move(onError));
  });
}

void WasapiCapture::stop() {
  if (stopEvent_) SetEvent(stopEvent_.get());
  if (thread_.joinable()) thread_.join();
  if (client_) {
    client_->Stop();
    log::info("audio: {} stopped ({} captured frames, {} silence frames, {} discontinuities)", describe(), captured_.load(),
              silence_.load(), discontinuities_.load());
  }
  capture_ = nullptr;
  client_ = nullptr;
}

void WasapiCapture::run(FrameFn onFrame, ErrorFn onError) {
  SetThreadDescription(GetCurrentThread(), L"nexo audio");
  winrt::init_apartment(winrt::apartment_type::multi_threaded);
  // MMCSS "Audio": the capture thread keeps its 10 ms cadence when a game saturates the CPU.
  DWORD taskIndex = 0;
  HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Audio", &taskIndex);
  if (!mmcss) SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);

  AudioFramer framer;
  framer.start(qpcMicros());
  const AudioFramer::EmitFn emit = [&](std::span<const int16_t> frame, bool silenceFill) {
    (silenceFill ? silence_ : captured_).fetch_add(1);
    onFrame(frame);
  };
  winrt::handle timer(CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS));
  if (timer) {
    LARGE_INTEGER due;
    due.QuadPart = -static_cast<LONGLONG>(kWakeMs) * 10'000;
    SetWaitableTimer(timer.get(), &due, kWakeMs, nullptr, nullptr, FALSE);
  }
  std::string error;
  const HANDLE handles[] = {stopEvent_.get(), sampleEvent_.get(), timer.get()};
  const DWORD handleCount = timer ? 3 : 2;
  for (;;) {
    if (WaitForMultipleObjects(handleCount, handles, FALSE, static_cast<DWORD>(kWakeMs)) == WAIT_OBJECT_0) break;
    // Drain every packet the engine has, then cut them into 10 ms frames.
    for (;;) {
      UINT32 next = 0;
      HRESULT hr = capture_->GetNextPacketSize(&next);
      if (FAILED(hr)) {
        error = "GetNextPacketSize: " + describeHresult(hr);
        break;
      }
      if (next == 0) break;
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      hr = capture_->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(hr)) {
        error = "GetBuffer: " + describeHresult(hr);
        break;
      }
      if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) discontinuities_.fetch_add(1);
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        framer.pushSilent(frames);
      } else {
        framer.push(std::span<const int16_t>(reinterpret_cast<const int16_t*>(data), static_cast<size_t>(frames) * kChannels));
      }
      capture_->ReleaseBuffer(frames);
    }
    if (!error.empty()) break;
    framer.drain(qpcMicros(), emit);
  }
  if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
  if (!error.empty()) {
    log::error("audio: {} failed: {}", describe(), error);
    if (onError) onError(error);
  }
  winrt::uninit_apartment();
}

} // namespace nexo
