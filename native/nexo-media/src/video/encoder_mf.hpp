#pragma once
// Hardware H.264 through a Media Foundation async MFT on our D3D11 device (SPEC-BETA §4.6).
//
// Frames go in as NV12 D3D11 textures from the encoder's own sample pool (MFCreateVideoSampleAllocatorEx, so a
// texture is only reused once the MFT has released it). Output arrives on an MF work-queue thread as Annex B
// access units, with SPS/PPS repaired onto every IDR, and is handed to `OutputFn` one at a time, in order.

#include <d3d11.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mftransform.h>
#include <winrt/base.h>

#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "d3d/device.hpp"
#include "video/output_size.hpp"
#include "video/pacer.hpp"

namespace nexo {

struct H264EncoderInfo {
  std::string name;   ///< MFT_FRIENDLY_NAME_Attribute, e.g. "NVIDIA H.264 Encoder MFT"
  std::string vendor; ///< from MFT_ENUM_HARDWARE_VENDOR_ID_Attribute
  std::optional<LUID> luid;
  winrt::com_ptr<IMFActivate> activate;
};

/// Hardware H.264 encoder MFTs that take NV12. With `adapter`, only those bound to that adapter (MFTEnum2 +
/// MFT_ENUM_ADAPTER_LUID). Requires MFStartup. Returns an empty list on failure (the reason is logged).
std::vector<H264EncoderInfo> listH264Encoders(const LUID* adapter);

enum class H264Profile { High, Main, ConstrainedBaseline };
/// NEXO_MEDIA_H264_PROFILE=high|main|baseline (default high, SPEC-BETA §4.6; see §11.4 for why baseline exists).
H264Profile h264ProfileFromEnv();

struct EncoderConfig {
  Size size;
  double fps = 60;
  EncoderRates rates;
  H264Profile profile = H264Profile::High;
};

struct EncodedFrame {
  std::vector<uint8_t> data; ///< Annex B access unit
  bool keyframe = false;
  int64_t timestampUs = 0;
};

class MfEncoder {
 public:
  using OutputFn = std::function<void(EncodedFrame&&)>;
  using ErrorFn = std::function<void(const std::string&)>;

  /// Tries each hardware MFT on the device's adapter. Throws ShareError(encoder-unavailable) when none works
  /// (no MFT, NVENC session limit reached, NEXO_MEDIA_DISABLE_HW=1…).
  static std::unique_ptr<MfEncoder> create(std::shared_ptr<D3DDevice> device, const EncoderConfig& config,
                                           OutputFn onOutput, ErrorFn onError);
  ~MfEncoder();
  MfEncoder(const MfEncoder&) = delete;
  MfEncoder& operator=(const MfEncoder&) = delete;

  struct Input {
    winrt::com_ptr<IMFSample> sample;
    winrt::com_ptr<ID3D11Texture2D> texture;
    UINT slice = 0;
  };
  /// A free NV12 input surface, or nullopt when all are still inside the encoder.
  std::optional<Input> allocateInput();

  enum class Submit { Accepted, Busy, Failed };
  /// Busy: the MFT hasn't asked for input yet (the frame is dropped; latest frame wins).
  Submit encode(const Input& input, int64_t timestampUs, bool keyframe);

  /// Live bitrate / rate-control changes (ICodecAPI).
  void setRates(const EncoderRates& rates);

  const std::string& name() const;
  const std::string& vendor() const;
  uint64_t keyframes() const;
  uint64_t outputBytes() const;
  uint64_t outputFrames() const;

  /// Stops the MFT and waits for an in-flight output callback. Idempotent; the destructor calls it.
  void shutdown();

  class Core; ///< defined in encoder_mf.cpp; only create() can make one
  explicit MfEncoder(std::shared_ptr<Core> core);

 private:
  std::shared_ptr<Core> core_;
};

} // namespace nexo
