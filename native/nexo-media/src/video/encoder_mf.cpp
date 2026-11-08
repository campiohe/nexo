#include "video/encoder_mf.hpp"

#include <codecapi.h>
#include <mferror.h>
#include <strmif.h>

#include <atomic>
#include <format>
#include <mutex>

#include "common/log.hpp"
#include "common/win_error.hpp"
#include "video/annexb.hpp"

namespace nexo {

namespace {

constexpr UINT32 kInputPoolInitial = 4;
constexpr UINT32 kInputPoolMax = 8;

HRESULT setU32(ICodecAPI* api, const GUID& key, uint32_t value) {
  VARIANT v;
  VariantInit(&v);
  v.vt = VT_UI4;
  v.ulVal = value;
  return api->SetValue(&key, &v);
}

HRESULT setBool(ICodecAPI* api, const GUID& key, bool value) {
  VARIANT v;
  VariantInit(&v);
  v.vt = VT_BOOL;
  v.boolVal = value ? VARIANT_TRUE : VARIANT_FALSE;
  return api->SetValue(&key, &v);
}

uint32_t clampU32(uint64_t v) {
  return static_cast<uint32_t>(std::min<uint64_t>(v, 0xFFFFFFFFull));
}

std::string allocatedString(IMFAttributes* attrs, const GUID& key) {
  wchar_t* value = nullptr;
  UINT32 len = 0;
  if (FAILED(attrs->GetAllocatedString(key, &value, &len)) || !value) return {};
  std::string out = toUtf8(std::wstring_view(value, len));
  CoTaskMemFree(value);
  return out;
}

std::optional<LUID> readLuid(IMFAttributes* attrs) {
  // Documented loosely: drivers expose it as a LUID blob, but accept a UINT64 too.
  UINT32 size = 0;
  if (SUCCEEDED(attrs->GetBlobSize(MFT_ENUM_ADAPTER_LUID, &size)) && size == sizeof(LUID)) {
    LUID luid{};
    if (SUCCEEDED(attrs->GetBlob(MFT_ENUM_ADAPTER_LUID, reinterpret_cast<UINT8*>(&luid), sizeof(luid), nullptr))) return luid;
  }
  UINT64 value = 0;
  if (SUCCEEDED(attrs->GetUINT64(MFT_ENUM_ADAPTER_LUID, &value))) {
    LUID luid{};
    luid.LowPart = static_cast<DWORD>(value & 0xFFFFFFFFull);
    luid.HighPart = static_cast<LONG>(value >> 32);
    return luid;
  }
  return std::nullopt;
}

std::string vendorFromHardwareId(const std::string& id) {
  // "VEN_10DE" (PCI vendor id in hex)
  const auto pos = id.find("VEN_");
  if (pos == std::string::npos) return id;
  try {
    return vendorName(static_cast<uint32_t>(std::stoul(id.substr(pos + 4, 4), nullptr, 16)));
  } catch (...) {
    return id;
  }
}

UINT32 profileValue(H264Profile p) {
  switch (p) {
    case H264Profile::Main: return eAVEncH264VProfile_Main;
    case H264Profile::ConstrainedBaseline: return eAVEncH264VProfile_ConstrainedBase;
    case H264Profile::High: break;
  }
  return eAVEncH264VProfile_High;
}

const char* profileName(H264Profile p) {
  switch (p) {
    case H264Profile::Main: return "main";
    case H264Profile::ConstrainedBaseline: return "constrained-baseline";
    case H264Profile::High: break;
  }
  return "high";
}

// Media Foundation's async callback → our encoder core. Holds the core weakly: the core owns the callback.
struct EventCallback : winrt::implements<EventCallback, IMFAsyncCallback> {
  std::weak_ptr<MfEncoder::Core> core;
  STDMETHODIMP GetParameters(DWORD*, DWORD*) noexcept override { return E_NOTIMPL; }
  STDMETHODIMP Invoke(IMFAsyncResult* result) noexcept override;
};

} // namespace

std::vector<H264EncoderInfo> listH264Encoders(const LUID* adapter) {
  std::vector<H264EncoderInfo> out;
  MFT_REGISTER_TYPE_INFO input{MFMediaType_Video, MFVideoFormat_NV12};
  MFT_REGISTER_TYPE_INFO output{MFMediaType_Video, MFVideoFormat_H264};
  const UINT32 flags = MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER;
  IMFActivate** activates = nullptr;
  UINT32 count = 0;
  HRESULT hr = E_FAIL;
  if (adapter) {
    winrt::com_ptr<IMFAttributes> attrs;
    check(MFCreateAttributes(attrs.put(), 1), "MFCreateAttributes");
    attrs->SetBlob(MFT_ENUM_ADAPTER_LUID, reinterpret_cast<const UINT8*>(adapter), sizeof(LUID));
    hr = MFTEnum2(MFT_CATEGORY_VIDEO_ENCODER, flags, &input, &output, attrs.get(), &activates, &count);
  } else {
    hr = MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, flags, &input, &output, &activates, &count);
  }
  if (FAILED(hr)) {
    log::warn("encoder: MFT enumeration failed: {}", describeHresult(hr));
    return out;
  }
  for (UINT32 i = 0; i < count; ++i) {
    winrt::com_ptr<IMFActivate> activate;
    activate.attach(activates[i]);
    H264EncoderInfo info;
    info.name = allocatedString(activate.get(), MFT_FRIENDLY_NAME_Attribute);
    info.vendor = vendorFromHardwareId(allocatedString(activate.get(), MFT_ENUM_HARDWARE_VENDOR_ID_Attribute));
    info.luid = readLuid(activate.get());
    if (adapter && info.luid && !sameLuid(*info.luid, *adapter)) continue; // belt and braces
    if (adapter && !info.luid) info.luid = *adapter;
    info.activate = std::move(activate);
    out.push_back(std::move(info));
  }
  CoTaskMemFree(activates);
  return out;
}

H264Profile h264ProfileFromEnv() {
  const auto v = envString("NEXO_MEDIA_H264_PROFILE");
  if (v == "main") return H264Profile::Main;
  if (v == "baseline" || v == "constrained-baseline") return H264Profile::ConstrainedBaseline;
  return H264Profile::High;
}

// ── Core ───────────────────────────────────────────────────────────────────────────────────────────────

class MfEncoder::Core : public std::enable_shared_from_this<MfEncoder::Core> {
 public:
  Core(std::shared_ptr<D3DDevice> device, EncoderConfig config, OutputFn onOutput, ErrorFn onError)
      : device_(std::move(device)), config_(config), onOutput_(std::move(onOutput)), onError_(std::move(onError)) {}

  void init(const H264EncoderInfo& info);
  void onEvent(IMFAsyncResult* result);
  std::optional<Input> allocateInput();
  Submit encode(const Input& input, int64_t timestampUs, bool keyframe);
  bool applyRates(const EncoderRates& rates) {
    std::lock_guard lock(mutex_);
    return !stopped_ && !failed_ && setRates(rates, false);
  }
  /// False when a mid-stream rate-control mode change didn't take. Caller holds mutex_ (or is init).
  bool setRates(const EncoderRates& rates, bool initial);
  void shutdown();

  double fps() const { return config_.fps; }

  std::string name;
  std::string vendor;
  std::atomic<uint64_t> keyframes{0};
  std::atomic<uint64_t> bytes{0};
  std::atomic<uint64_t> frames{0};

 private:
  void configureCodecApi();
  void setOutputType();
  void setInputType();
  void initAllocator();
  void processOutput(std::vector<EncodedFrame>& out, std::string& error);
  void failLocked(std::string& error, std::string message);

  std::shared_ptr<D3DDevice> device_;
  EncoderConfig config_;
  OutputFn onOutput_;
  ErrorFn onError_;

  std::mutex mutex_; ///< every IMFTransform / ICodecAPI call, plus the state below
  winrt::com_ptr<IMFTransform> transform_;
  winrt::com_ptr<ICodecAPI> codecApi_;
  winrt::com_ptr<IMFMediaEventGenerator> generator_;
  winrt::com_ptr<IMFAsyncCallback> callback_;
  winrt::com_ptr<IMFVideoSampleAllocatorEx> allocator_;
  DWORD inputId_ = 0;
  DWORD outputId_ = 0;
  int needInput_ = 0;
  bool stopped_ = false;
  bool failed_ = false;
  std::optional<EncoderRates> rates_;
  h264::ParameterSetCache paramSets_;
  bool loggedSps_ = false;
  uint64_t repairs_ = 0;

  /// Held while an output is handed to onOutput_, so shutdown() can wait for it (the publisher it calls into is
  /// destroyed right after the encoder).
  std::mutex deliverMutex_;
};

STDMETHODIMP EventCallback::Invoke(IMFAsyncResult* result) noexcept {
  if (auto c = core.lock()) {
    try {
      c->onEvent(result);
    } catch (const std::exception& e) {
      log::error("encoder: event handler failed: {}", e.what());
    }
  }
  return S_OK;
}

void MfEncoder::Core::init(const H264EncoderInfo& info) {
  name = info.name.empty() ? "H.264 hardware MFT" : info.name;
  vendor = info.vendor;
  check(info.activate->ActivateObject(IID_PPV_ARGS(transform_.put())), "IMFActivate::ActivateObject");

  winrt::com_ptr<IMFAttributes> attrs;
  check(transform_->GetAttributes(attrs.put()), "IMFTransform::GetAttributes");
  UINT32 isAsync = 0;
  attrs->GetUINT32(MF_TRANSFORM_ASYNC, &isAsync);
  if (!isAsync) throw HrError(E_NOTIMPL, "MFT is synchronous (hardware encoders are async)");
  check(attrs->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE), "MF_TRANSFORM_ASYNC_UNLOCK");
  attrs->SetUINT32(MF_LOW_LATENCY, TRUE);
  UINT32 d3d11Aware = 0;
  attrs->GetUINT32(MF_SA_D3D11_AWARE, &d3d11Aware);
  if (!d3d11Aware) throw HrError(E_NOTIMPL, "MFT is not D3D11-aware");

  const HRESULT ids = transform_->GetStreamIDs(1, &inputId_, 1, &outputId_);
  if (ids == E_NOTIMPL) {
    inputId_ = 0;
    outputId_ = 0;
  } else {
    check(ids, "IMFTransform::GetStreamIDs");
  }

  check(transform_->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, reinterpret_cast<ULONG_PTR>(device_->dxgiManager())),
        "MFT_MESSAGE_SET_D3D_MANAGER");
  codecApi_ = transform_.try_as<ICodecAPI>();
  if (!codecApi_) throw HrError(E_NOINTERFACE, "MFT has no ICodecAPI");

  // Some MFTs (Intel) only honor the rate-control mode when it is set before the media types.
  configureCodecApi();
  setOutputType();
  setInputType();
  // After the media types: NVIDIA rejects it before (E_INVALIDARG). Low-latency mode already rules B-frames
  // out on the encoders we've seen, so a refusal is only worth a debug line.
  if (const HRESULT hr = setU32(codecApi_.get(), CODECAPI_AVEncMPVDefaultBPictureCount, 0); FAILED(hr)) {
    log::debug("encoder: B-frames=0 not applied ({}), relying on low-latency mode", describeHresult(hr));
  }
  initAllocator();
  {
    VARIANT v;
    VariantInit(&v);
    if (SUCCEEDED(codecApi_->GetValue(&CODECAPI_AVEncCommonRateControlMode, &v))) {
      const UINT32 wanted = config_.rates.mode == RateMode::Cbr ? eAVEncCommonRateControlMode_CBR
                                                                 : eAVEncCommonRateControlMode_PeakConstrainedVBR;
      log::info("encoder: rate control mode {} requested, the MFT reports {}", wanted, v.ulVal);
    }
    VariantClear(&v);
  }

  generator_ = transform_.as<IMFMediaEventGenerator>();
  auto cb = winrt::make_self<EventCallback>();
  cb->core = weak_from_this();
  callback_ = cb.as<IMFAsyncCallback>();

  check(transform_->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0), "MFT_MESSAGE_COMMAND_FLUSH");
  check(transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0), "MFT_MESSAGE_NOTIFY_BEGIN_STREAMING");
  check(transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0), "MFT_MESSAGE_NOTIFY_START_OF_STREAM");
  check(generator_->BeginGetEvent(callback_.get(), nullptr), "IMFMediaEventGenerator::BeginGetEvent");
}

void MfEncoder::Core::configureCodecApi() {
  auto* api = codecApi_.get();
  auto warnIfFailed = [](HRESULT hr, const char* what) {
    if (FAILED(hr)) log::warn("encoder: {} not applied: {}", what, describeHresult(hr));
  };
  warnIfFailed(setBool(api, CODECAPI_AVLowLatencyMode, true), "AVLowLatencyMode");
  // Very long GOP: IDRs come on demand (new viewer, loss). A 2-minute GOP is only a safety net.
  const auto gop = clampU32(static_cast<uint64_t>(std::max(1.0, config_.fps) * 120));
  warnIfFailed(setU32(api, CODECAPI_AVEncMPVGOPSize, gop), "GOP size");
  setRates(config_.rates, true);
}

bool MfEncoder::Core::setRates(const EncoderRates& r, bool initial) {
  auto* api = codecApi_.get();
  bool modeApplied = true;
  if (initial || !rates_ || rates_->mode != r.mode) {
    const UINT32 mode = r.mode == RateMode::Cbr ? eAVEncCommonRateControlMode_CBR : eAVEncCommonRateControlMode_PeakConstrainedVBR;
    const HRESULT hr = setU32(api, CODECAPI_AVEncCommonRateControlMode, mode);
    if (FAILED(hr)) log::warn("encoder: rate control mode {} not applied: {}", mode, describeHresult(hr));
    if (!initial) {
      // A mid-stream switch (update: motion ↔ detail). Some MFTs only honor the mode at init, so read it back
      // instead of trusting the HRESULT.
      VARIANT v;
      VariantInit(&v);
      const HRESULT read = api->GetValue(&CODECAPI_AVEncCommonRateControlMode, &v);
      if (SUCCEEDED(read)) {
        modeApplied = v.ulVal == mode;
        log::info("encoder: rate control mode set to {} mid-stream, the MFT now reports {} ({})", mode, v.ulVal,
                  modeApplied ? "applied" : "NOT applied");
      } else {
        modeApplied = SUCCEEDED(hr);
        log::info("encoder: rate control mode set to {} mid-stream ({}), read-back unsupported: {}", mode,
                  SUCCEEDED(hr) ? "accepted" : "refused", describeHresult(read));
      }
      VariantClear(&v);
    }
  }
  HRESULT hr = setU32(api, CODECAPI_AVEncCommonMeanBitRate, clampU32(r.meanBitrate));
  if (FAILED(hr)) log::warn("encoder: mean bitrate not applied: {}", describeHresult(hr));
  if (r.mode == RateMode::PeakConstrainedVbr) {
    hr = setU32(api, CODECAPI_AVEncCommonMaxBitRate, clampU32(r.peakBitrate));
    if (FAILED(hr)) log::warn("encoder: peak bitrate not applied: {}", describeHresult(hr));
  }
  if (r.maxQp && (initial || !rates_ || rates_->maxQp != r.maxQp)) {
    if (api->IsSupported(&CODECAPI_AVEncVideoMaxQP) == S_OK) {
      hr = setU32(api, CODECAPI_AVEncVideoMaxQP, *r.maxQp);
      if (FAILED(hr)) log::warn("encoder: max QP not applied: {}", describeHresult(hr));
    } else if (initial) {
      log::info("encoder: AVEncVideoMaxQP unsupported by {}", name);
    }
  }
  rates_ = r;
  return modeApplied;
}

void MfEncoder::Core::setOutputType() {
  winrt::com_ptr<IMFMediaType> type;
  check(MFCreateMediaType(type.put()), "MFCreateMediaType");
  type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
  type->SetUINT32(MF_MT_AVG_BITRATE, clampU32(config_.rates.meanBitrate));
  check(MFSetAttributeSize(type.get(), MF_MT_FRAME_SIZE, config_.size.width, config_.size.height), "MF_MT_FRAME_SIZE");
  // Integer fps in the type: fractional presets don't exist and some MFTs reject odd ratios.
  check(MFSetAttributeRatio(type.get(), MF_MT_FRAME_RATE, static_cast<UINT32>(std::lround(config_.fps)), 1), "MF_MT_FRAME_RATE");
  check(MFSetAttributeRatio(type.get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1), "MF_MT_PIXEL_ASPECT_RATIO");
  type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  type->SetUINT32(MF_MT_MPEG2_PROFILE, profileValue(config_.profile));
  // BT.709 limited range, so the encoder writes it into the SPS VUI (SPEC-BETA §4.5).
  type->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235);
  type->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709);
  type->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709);
  type->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709);
  check(transform_->SetOutputType(outputId_, type.get(), 0), std::format("SetOutputType (H.264 {} {}x{})", profileName(config_.profile),
                                                                         config_.size.width, config_.size.height));

  winrt::com_ptr<IMFMediaType> current;
  if (SUCCEEDED(transform_->GetOutputCurrentType(outputId_, current.put()))) {
    UINT32 size = 0;
    if (SUCCEEDED(current->GetBlobSize(MF_MT_MPEG_SEQUENCE_HEADER, &size)) && size > 0) {
      std::vector<uint8_t> header(size);
      if (SUCCEEDED(current->GetBlob(MF_MT_MPEG_SEQUENCE_HEADER, header.data(), size, nullptr))) paramSets_.seed(header);
    }
  }
}

void MfEncoder::Core::setInputType() {
  if (EventSink::instance().minLevel() <= ipc::LogLevel::Debug) {
    // Which input formats this MFT takes (an RGB input would let a 1:1 share skip the video processor).
    std::string offered;
    for (DWORD i = 0;; ++i) {
      winrt::com_ptr<IMFMediaType> type;
      if (FAILED(transform_->GetInputAvailableType(inputId_, i, type.put()))) break;
      GUID subtype{};
      type->GetGUID(MF_MT_SUBTYPE, &subtype);
      char fourcc[5] = {static_cast<char>(subtype.Data1 & 0xFF), static_cast<char>((subtype.Data1 >> 8) & 0xFF),
                        static_cast<char>((subtype.Data1 >> 16) & 0xFF), static_cast<char>((subtype.Data1 >> 24) & 0xFF), 0};
      offered += std::format("{}{} (0x{:08X})", offered.empty() ? "" : ", ", subtype.Data1 < 0x100 ? "d3dfmt" : fourcc,
                             static_cast<uint32_t>(subtype.Data1));
    }
    log::debug("encoder: {} input types: {}", name, offered);
  }
  for (DWORD i = 0;; ++i) {
    winrt::com_ptr<IMFMediaType> type;
    const HRESULT hr = transform_->GetInputAvailableType(inputId_, i, type.put());
    if (hr == MF_E_NO_MORE_TYPES) break;
    check(hr, "GetInputAvailableType");
    GUID subtype{};
    type->GetGUID(MF_MT_SUBTYPE, &subtype);
    if (subtype != MFVideoFormat_NV12) continue;
    check(MFSetAttributeSize(type.get(), MF_MT_FRAME_SIZE, config_.size.width, config_.size.height), "input MF_MT_FRAME_SIZE");
    check(MFSetAttributeRatio(type.get(), MF_MT_FRAME_RATE, static_cast<UINT32>(std::lround(config_.fps)), 1), "input MF_MT_FRAME_RATE");
    type->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235);
    type->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709);
    check(transform_->SetInputType(inputId_, type.get(), 0), "SetInputType (NV12)");
    return;
  }
  throw HrError(MF_E_INVALIDMEDIATYPE, "MFT offers no NV12 input type");
}

void MfEncoder::Core::initAllocator() {
  check(MFCreateVideoSampleAllocatorEx(IID_PPV_ARGS(allocator_.put())), "MFCreateVideoSampleAllocatorEx");
  check(allocator_->SetDirectXManager(device_->dxgiManager()), "IMFVideoSampleAllocatorEx::SetDirectXManager");
  winrt::com_ptr<IMFMediaType> type;
  check(MFCreateMediaType(type.put()), "MFCreateMediaType");
  type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
  check(MFSetAttributeSize(type.get(), MF_MT_FRAME_SIZE, config_.size.width, config_.size.height), "allocator MF_MT_FRAME_SIZE");
  check(MFSetAttributeRatio(type.get(), MF_MT_FRAME_RATE, static_cast<UINT32>(std::lround(config_.fps)), 1), "allocator MF_MT_FRAME_RATE");
  type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);

  winrt::com_ptr<IMFAttributes> attrs;
  check(MFCreateAttributes(attrs.put(), 2), "MFCreateAttributes");
  // RENDER_TARGET: the video processor writes the NV12 frame. SHADER_RESOURCE: some MFTs read input with a
  // shader. Fall back to RENDER_TARGET only if a driver refuses the combination.
  attrs->SetUINT32(MF_SA_D3D11_USAGE, D3D11_USAGE_DEFAULT);
  attrs->SetUINT32(MF_SA_D3D11_BINDFLAGS, D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE);
  HRESULT hr = allocator_->InitializeSampleAllocatorEx(kInputPoolInitial, kInputPoolMax, attrs.get(), type.get());
  if (FAILED(hr)) {
    attrs->SetUINT32(MF_SA_D3D11_BINDFLAGS, D3D11_BIND_RENDER_TARGET);
    hr = allocator_->InitializeSampleAllocatorEx(kInputPoolInitial, kInputPoolMax, attrs.get(), type.get());
  }
  check(hr, "InitializeSampleAllocatorEx (NV12)");
}

std::optional<MfEncoder::Input> MfEncoder::Core::allocateInput() {
  winrt::com_ptr<IMFSample> sample;
  const HRESULT hr = allocator_->AllocateSample(sample.put());
  if (hr == MF_E_SAMPLEALLOCATOR_EMPTY) return std::nullopt;
  check(hr, "AllocateSample");
  winrt::com_ptr<IMFMediaBuffer> buffer;
  check(sample->GetBufferByIndex(0, buffer.put()), "IMFSample::GetBufferByIndex");
  auto dxgi = buffer.as<IMFDXGIBuffer>();
  Input in;
  check(dxgi->GetResource(IID_PPV_ARGS(in.texture.put())), "IMFDXGIBuffer::GetResource");
  check(dxgi->GetSubresourceIndex(&in.slice), "IMFDXGIBuffer::GetSubresourceIndex");
  in.sample = std::move(sample);
  return in;
}

MfEncoder::Submit MfEncoder::Core::encode(const Input& input, int64_t timestampUs, bool keyframe) {
  std::string error;
  Submit result = Submit::Accepted;
  {
    std::lock_guard lock(mutex_);
    if (stopped_ || failed_) return Submit::Failed;
    if (needInput_ <= 0) return Submit::Busy;
    input.sample->SetSampleTime(timestampUs * 10);
    input.sample->SetSampleDuration(static_cast<LONGLONG>(10'000'000.0 / std::max(1.0, config_.fps)));
    if (keyframe) {
      const HRESULT khr = setU32(codecApi_.get(), CODECAPI_AVEncVideoForceKeyFrame, 1);
      if (FAILED(khr)) log::warn("encoder: force keyframe failed: {}", describeHresult(khr));
      else log::debug("encoder: IDR forced at {} us", timestampUs);
    }
    const HRESULT hr = transform_->ProcessInput(inputId_, input.sample.get(), 0);
    if (hr == MF_E_NOTACCEPTING) return Submit::Busy;
    if (FAILED(hr)) {
      failLocked(error, "ProcessInput: " + describeHresult(hr));
      result = Submit::Failed;
    } else {
      --needInput_;
    }
  }
  if (!error.empty()) onError_(error);
  return result;
}

void MfEncoder::Core::failLocked(std::string& error, std::string message) {
  if (failed_) return;
  failed_ = true;
  error = "encoder " + name + ": " + message;
}

void MfEncoder::Core::onEvent(IMFAsyncResult* result) {
  winrt::com_ptr<IMFMediaEvent> event;
  std::vector<EncodedFrame> outputs;
  std::string error;
  {
    std::lock_guard lock(mutex_);
    if (stopped_) return;
    const HRESULT hr = generator_->EndGetEvent(result, event.put());
    if (hr == MF_E_SHUTDOWN) return;
    if (FAILED(hr)) {
      failLocked(error, "EndGetEvent: " + describeHresult(hr));
    } else {
      MediaEventType type = MEUnknown;
      event->GetType(&type);
      HRESULT status = S_OK;
      event->GetStatus(&status);
      if (FAILED(status)) {
        failLocked(error, std::format("event {} failed: {}", type, describeHresult(status)));
      } else if (type == METransformNeedInput) {
        ++needInput_;
      } else if (type == METransformHaveOutput) {
        processOutput(outputs, error);
      } else if (type == MEError) {
        failLocked(error, "MEError");
      }
    }
  }
  if (!error.empty()) {
    onError_(error);
    return; // don't re-arm a failed encoder
  }
  if (!outputs.empty()) {
    std::lock_guard deliver(deliverMutex_);
    for (auto& frame : outputs) {
      {
        std::lock_guard lock(mutex_);
        if (stopped_) return;
      }
      onOutput_(std::move(frame));
    }
  }
  // Re-arm only after delivering: the next event can't run concurrently, so outputs stay ordered and the
  // publisher (not thread-safe for captures) is only called from one thread at a time.
  std::lock_guard lock(mutex_);
  if (stopped_) return;
  const HRESULT hr = generator_->BeginGetEvent(callback_.get(), nullptr);
  if (FAILED(hr) && hr != MF_E_SHUTDOWN) log::error("encoder: BeginGetEvent failed: {}", describeHresult(hr));
}

void MfEncoder::Core::processOutput(std::vector<EncodedFrame>& out, std::string& error) {
  MFT_OUTPUT_STREAM_INFO info{};
  HRESULT hr = transform_->GetOutputStreamInfo(outputId_, &info);
  if (FAILED(hr)) return failLocked(error, "GetOutputStreamInfo: " + describeHresult(hr));

  MFT_OUTPUT_DATA_BUFFER buffer{};
  buffer.dwStreamID = outputId_;
  winrt::com_ptr<IMFSample> own;
  const bool mftProvides = info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES);
  if (!mftProvides) {
    winrt::com_ptr<IMFMediaBuffer> mem;
    check(MFCreateSample(own.put()), "MFCreateSample");
    check(MFCreateMemoryBuffer(std::max<DWORD>(info.cbSize, 4u << 20), mem.put()), "MFCreateMemoryBuffer");
    own->AddBuffer(mem.get());
    buffer.pSample = own.get();
  }
  DWORD status = 0;
  hr = transform_->ProcessOutput(0, 1, &buffer, &status);
  winrt::com_ptr<IMFCollection> events;
  events.attach(buffer.pEvents);
  winrt::com_ptr<IMFSample> sample = own;
  if (mftProvides) sample.attach(buffer.pSample);

  if (hr == MF_E_TRANSFORM_STREAM_CHANGE) {
    // The MFT changed its output type (e.g. it added the sequence header): accept its first offer.
    winrt::com_ptr<IMFMediaType> type;
    if (SUCCEEDED(transform_->GetOutputAvailableType(outputId_, 0, type.put()))) transform_->SetOutputType(outputId_, type.get(), 0);
    log::info("encoder: output type renegotiated");
    return;
  }
  if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) return;
  if (FAILED(hr)) return failLocked(error, "ProcessOutput: " + describeHresult(hr));
  if (!sample) return;

  winrt::com_ptr<IMFMediaBuffer> contiguous;
  hr = sample->ConvertToContiguousBuffer(contiguous.put());
  if (FAILED(hr)) return failLocked(error, "ConvertToContiguousBuffer: " + describeHresult(hr));
  BYTE* data = nullptr;
  DWORD length = 0;
  if (FAILED(contiguous->Lock(&data, nullptr, &length))) return failLocked(error, "IMFMediaBuffer::Lock");
  std::span<const uint8_t> au(data, length);
  bool repaired = false;
  EncodedFrame frame;
  frame.data = paramSets_.process(au, &repaired);
  contiguous->Unlock();
  if (frame.data.empty()) return;

  UINT32 cleanPoint = 0;
  sample->GetUINT32(MFSampleExtension_CleanPoint, &cleanPoint);
  frame.keyframe = cleanPoint != 0 || h264::containsIdr(frame.data);
  LONGLONG time = 0;
  if (SUCCEEDED(sample->GetSampleTime(&time))) frame.timestampUs = time / 10;

  if (repaired && ++repairs_ <= 3) log::info("encoder: prepended cached SPS/PPS to an IDR ({} so far)", repairs_);
  if (!loggedSps_ && paramSets_.hasParameterSets()) {
    loggedSps_ = true;
    if (auto sps = h264::parseSpsHeader(paramSets_.sps())) {
      log::info("encoder: {} produces H.264 profile_idc {} constraints 0x{:02X} level_idc {} (requested {})", name,
                sps->profileIdc, sps->constraints, sps->levelIdc, profileName(config_.profile));
    }
  }
  if (frame.keyframe) {
    keyframes.fetch_add(1);
    log::debug("encoder: IDR out at {} us, {} bytes", frame.timestampUs, frame.data.size());
  }
  bytes.fetch_add(frame.data.size());
  frames.fetch_add(1);
  out.push_back(std::move(frame));
}

void MfEncoder::Core::shutdown() {
  {
    std::lock_guard lock(mutex_);
    if (stopped_) return;
    stopped_ = true;
    if (transform_) {
      transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
      transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
      // Completes the pending BeginGetEvent with MF_E_SHUTDOWN, so no callback stays queued.
      if (auto s = transform_.try_as<IMFShutdown>()) s->Shutdown();
    }
  }
  // An output may be on its way to the publisher; wait for it.
  std::lock_guard deliver(deliverMutex_);
  if (allocator_) allocator_->UninitializeSampleAllocator();
}

// ── Public wrapper ─────────────────────────────────────────────────────────────────────────────────────

MfEncoder::MfEncoder(std::shared_ptr<Core> core) : core_(std::move(core)) {}

MfEncoder::~MfEncoder() {
  shutdown();
}

std::unique_ptr<MfEncoder> MfEncoder::create(std::shared_ptr<D3DDevice> device, const EncoderConfig& config,
                                             OutputFn onOutput, ErrorFn onError) {
  if (envFlag("NEXO_MEDIA_DISABLE_HW")) {
    throw ShareError(ipc::ErrorCode::EncoderUnavailable, "hardware encoding disabled (NEXO_MEDIA_DISABLE_HW=1)");
  }
  const LUID luid = device->adapter().luid;
  auto candidates = listH264Encoders(&luid);
  if (candidates.empty()) {
    throw ShareError(ipc::ErrorCode::EncoderUnavailable, "no hardware H.264 encoder on " + device->adapter().name);
  }
  std::string failures;
  for (const auto& info : candidates) {
    auto core = std::make_shared<Core>(device, config, onOutput, onError);
    try {
      core->init(info);
      log::info("encoder: {} ({}) {}x{}@{} {} {} kbps", core->name, core->vendor, config.size.width, config.size.height,
                config.fps, config.rates.mode == RateMode::Cbr ? "CBR" : "PCVBR", config.rates.meanBitrate / 1000);
      return std::make_unique<MfEncoder>(std::move(core));
    } catch (const std::exception& e) {
      // Typical: the NVENC session limit (another app is encoding) surfaces here as E_FAIL / MF_E_*.
      core->shutdown();
      log::warn("encoder: {} unusable: {}", info.name, e.what());
      failures += (failures.empty() ? "" : "; ") + info.name + ": " + e.what();
    }
  }
  throw ShareError(ipc::ErrorCode::EncoderUnavailable, "hardware H.264 encoder failed to start (" + failures + ")");
}

std::optional<MfEncoder::Input> MfEncoder::allocateInput() {
  return core_->allocateInput();
}

MfEncoder::Submit MfEncoder::encode(const Input& input, int64_t timestampUs, bool keyframe) {
  return core_->encode(input, timestampUs, keyframe);
}

bool MfEncoder::setRates(const EncoderRates& rates) {
  return core_->applyRates(rates);
}

const std::string& MfEncoder::name() const { return core_->name; }
double MfEncoder::fps() const { return core_->fps(); }
const std::string& MfEncoder::vendor() const { return core_->vendor; }
uint64_t MfEncoder::keyframes() const { return core_->keyframes.load(); }
uint64_t MfEncoder::outputBytes() const { return core_->bytes.load(); }
uint64_t MfEncoder::outputFrames() const { return core_->frames.load(); }

void MfEncoder::shutdown() {
  if (core_) core_->shutdown();
}

} // namespace nexo
