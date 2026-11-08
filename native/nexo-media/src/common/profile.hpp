#pragma once
// Pipeline timing (docs/benchmarks/beta-m3-fps-gap.md). Off unless NEXO_MEDIA_PROFILE=1; then the encode
// thread logs one "profile: …" line per second (an info `log` event, so it shows in a dry run too).
//
// CPU stages are timed with QPC. GPU jobs (the ring copy, the conversion) are bracketed by a GpuProbe: D3D11
// timestamp queries give their execution time on the GPU, and a fence signaled right after them gives the time
// from submission to completion (queueing behind other processes' work included). Off, every call is a
// branch on a cached flag.

#include <d3d11_4.h>
#include <winrt/base.h>

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace nexo::profile {

enum class Stage : int {
  WgcArrive,     ///< interval between FrameArrived callbacks (count = WGC's delivery rate)
  WgcDelay,      ///< FrameArrived time - the frame's SystemRelativeTime
  WgcCallback,   ///< CPU time inside FrameArrived (the copy submission, lock waits)
  CopyGpu,       ///< GPU execution time of the ring copy
  CopyDone,      ///< ring copy: submission -> GPU completion
  ConvertCpu,    ///< CPU time of the conversion submission (VideoProcessorBlt…)
  ConvertGpu,    ///< GPU execution time of the conversion
  ConvertDone,   ///< conversion: submission -> GPU completion
  ConvertQueue,  ///< pipelined conversion: submission -> handed to the encoder
  EncodeInCpu,   ///< CPU time of IMFTransform::ProcessInput
  EncodeLatency, ///< ProcessInput -> the access unit out of the MFT
  EncodeWait,    ///< encode thread blocked waiting (for a frame, its pacing slot or a retry)
  FrameAge,      ///< frame SystemRelativeTime -> start of its conversion
  Count
};

/// NEXO_MEDIA_PROFILE=1 (read once).
bool enabled();
/// Adds one sample of `us` microseconds to `stage`. No-op when profiling is off.
void record(Stage stage, int64_t us);
/// Counters without a duration (pool empty, busy, held frames…), by name.
void count(const char* name, uint64_t n = 1);
/// "profile: …" summary of everything recorded since the last call, over `seconds`; resets the counters.
std::string report(double seconds);

/// Brackets GPU jobs on a D3D11 immediate context. A worker thread waits for each job's fence value and reads
/// its timestamps. Inactive (all calls no-ops) when profiling is off or the device has no ID3D11Device5.
class GpuProbe {
 public:
  GpuProbe(ID3D11Device* device, ID3D11DeviceContext* context);
  ~GpuProbe();
  GpuProbe(const GpuProbe&) = delete;
  GpuProbe& operator=(const GpuProbe&) = delete;

  struct Scope {
    int slot = -1;
    int64_t submitUs = 0;
  };
  /// Starts a job: takes the device's multithread lock until end(), so other threads' commands don't land
  /// between the two timestamps.
  Scope begin();
  void end(Scope scope, Stage gpu, Stage done);

 private:
  struct Slot {
    winrt::com_ptr<ID3D11Query> disjoint;
    winrt::com_ptr<ID3D11Query> start;
    winrt::com_ptr<ID3D11Query> stop;
    bool busy = false;
  };
  struct Pending {
    int slot;
    uint64_t fenceValue;
    int64_t submitUs;
    Stage gpu;
    Stage done;
  };
  void worker();

  winrt::com_ptr<ID3D11Device> device_;
  winrt::com_ptr<ID3D11DeviceContext> context_;
  winrt::com_ptr<ID3D11DeviceContext4> context4_;
  winrt::com_ptr<ID3D11Fence> fence_;
  winrt::com_ptr<ID3D10Multithread> multithread_;
  winrt::handle fenceEvent_;
  std::vector<Slot> slots_;
  uint64_t fenceValue_ = 0;
  std::mutex mutex_;
  std::condition_variable cv_;
  std::deque<Pending> pending_;
  bool stop_ = false;
  bool active_ = false;
  std::thread thread_;
};

} // namespace nexo::profile
