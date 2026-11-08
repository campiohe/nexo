#include "common/profile.hpp"

#include <windows.h>

#include <algorithm>
#include <array>
#include <format>
#include <map>

#include "capture/frame_ring.hpp"
#include "common/win_error.hpp"

namespace nexo::profile {
namespace {

struct Accumulator {
  std::atomic<uint64_t> count{0};
  std::atomic<uint64_t> sumUs{0};
  std::atomic<int64_t> maxUs{0};
};

std::array<Accumulator, static_cast<size_t>(Stage::Count)>& accumulators() {
  static std::array<Accumulator, static_cast<size_t>(Stage::Count)> a;
  return a;
}

std::mutex& countersMutex() {
  static std::mutex m;
  return m;
}

std::map<std::string, uint64_t>& counters() {
  static std::map<std::string, uint64_t> c;
  return c;
}

constexpr const char* kNames[] = {"wgc",        "wgcDelay",   "wgcCb",     "copyGpu",  "copyDone",
                                  "convertCpu", "convertGpu", "convertDone", "convertQ", "encIn",  "encLatency",
                                  "wait",       "age"};
static_assert(std::size(kNames) == static_cast<size_t>(Stage::Count));

constexpr int kSlots = 16;

} // namespace

bool enabled() {
  static const bool on = envFlag("NEXO_MEDIA_PROFILE");
  return on;
}

void record(Stage stage, int64_t us) {
  if (!enabled()) return;
  auto& a = accumulators()[static_cast<size_t>(stage)];
  a.count.fetch_add(1, std::memory_order_relaxed);
  a.sumUs.fetch_add(static_cast<uint64_t>(std::max<int64_t>(0, us)), std::memory_order_relaxed);
  int64_t prev = a.maxUs.load(std::memory_order_relaxed);
  while (us > prev && !a.maxUs.compare_exchange_weak(prev, us, std::memory_order_relaxed)) {
  }
}

void count(const char* name, uint64_t n) {
  if (!enabled()) return;
  std::lock_guard lock(countersMutex());
  counters()[name] += n;
}

std::string report(double seconds) {
  std::string out = "profile:";
  const double dt = seconds > 0 ? seconds : 1.0;
  for (size_t i = 0; i < static_cast<size_t>(Stage::Count); ++i) {
    auto& a = accumulators()[i];
    const uint64_t n = a.count.exchange(0);
    const uint64_t sum = a.sumUs.exchange(0);
    const int64_t max = a.maxUs.exchange(0);
    if (n == 0) continue;
    const auto stage = static_cast<Stage>(i);
    if (stage == Stage::WgcArrive) {
      // The arrival rate is the interesting number; the gaps say how bursty it is.
      out += std::format(" {} {:.1f}/s gap {:.1f}/{:.1f}ms", kNames[i], double(n) / dt, double(sum) / double(n) / 1000.0,
                         double(max) / 1000.0);
    } else if (stage == Stage::EncodeWait) {
      out += std::format(" {} {:.0f}%", kNames[i], double(sum) / (dt * 1e4));
    } else {
      out += std::format(" {} {:.2f}/{:.2f}ms", kNames[i], double(sum) / double(n) / 1000.0, double(max) / 1000.0);
    }
  }
  std::lock_guard lock(countersMutex());
  for (auto& [name, n] : counters()) {
    if (n) out += std::format(" {} {}", name, n);
    n = 0;
  }
  return out;
}

// ── GpuProbe ──────────────────────────────────────────────────────────────────────────────────────────

GpuProbe::GpuProbe(ID3D11Device* device, ID3D11DeviceContext* context) {
  if (!enabled()) return;
  device_.copy_from(device);
  context_.copy_from(context);
  auto device5 = device_.try_as<ID3D11Device5>();
  context4_ = context_.try_as<ID3D11DeviceContext4>();
  multithread_ = context_.try_as<ID3D10Multithread>();
  if (!device5 || !context4_ || !multithread_) return;
  if (FAILED(device5->CreateFence(0, D3D11_FENCE_FLAG_NONE, IID_PPV_ARGS(fence_.put())))) return;
  fenceEvent_.attach(CreateEventW(nullptr, FALSE, FALSE, nullptr));
  slots_.resize(kSlots);
  for (auto& s : slots_) {
    D3D11_QUERY_DESC d{D3D11_QUERY_TIMESTAMP_DISJOINT, 0};
    if (FAILED(device_->CreateQuery(&d, s.disjoint.put()))) return;
    d.Query = D3D11_QUERY_TIMESTAMP;
    if (FAILED(device_->CreateQuery(&d, s.start.put())) || FAILED(device_->CreateQuery(&d, s.stop.put()))) return;
  }
  active_ = true;
  thread_ = std::thread([this] { worker(); });
}

GpuProbe::~GpuProbe() {
  {
    std::lock_guard lock(mutex_);
    stop_ = true;
  }
  cv_.notify_all();
  if (thread_.joinable()) thread_.join();
}

GpuProbe::Scope GpuProbe::begin() {
  if (!active_) return {};
  multithread_->Enter();
  Scope scope;
  scope.submitUs = qpcMicros();
  {
    std::lock_guard lock(mutex_);
    for (int i = 0; i < kSlots; ++i) {
      if (!slots_[i].busy) {
        slots_[i].busy = true;
        scope.slot = i;
        break;
      }
    }
  }
  if (scope.slot >= 0) {
    context_->Begin(slots_[scope.slot].disjoint.get());
    context_->End(slots_[scope.slot].start.get());
  }
  return scope;
}

void GpuProbe::end(Scope scope, Stage gpu, Stage done) {
  if (!active_) return;
  if (scope.slot >= 0) {
    const Slot& s = slots_[scope.slot];
    context_->End(s.stop.get());
    context_->End(s.disjoint.get());
    const uint64_t value = ++fenceValue_; // under the multithread lock
    context4_->Signal(fence_.get(), value);
    {
      std::lock_guard lock(mutex_);
      pending_.push_back({scope.slot, value, scope.submitUs, gpu, done});
    }
    cv_.notify_one();
  }
  multithread_->Leave();
}

void GpuProbe::worker() {
  SetThreadDescription(GetCurrentThread(), L"nexo profile");
  for (;;) {
    Pending p{};
    {
      std::unique_lock lock(mutex_);
      cv_.wait(lock, [this] { return stop_ || !pending_.empty(); });
      if (stop_) return;
      p = pending_.front();
      pending_.pop_front();
    }
    bool completed = false;
    if (SUCCEEDED(fence_->SetEventOnCompletion(p.fenceValue, fenceEvent_.get()))) {
      // Bounded, so a lost device (the fence never completes) can't hang shutdown.
      for (int i = 0; i < 20 && !completed; ++i) {
        completed = WaitForSingleObject(fenceEvent_.get(), 100) == WAIT_OBJECT_0 || fence_->GetCompletedValue() >= p.fenceValue;
        std::lock_guard lock(mutex_);
        if (stop_) return;
      }
    }
    if (completed) {
      record(p.done, qpcMicros() - p.submitUs);
      const Slot& s = slots_[p.slot];
      D3D11_QUERY_DATA_TIMESTAMP_DISJOINT dj{};
      UINT64 t0 = 0;
      UINT64 t1 = 0;
      // Already complete (the fence is past them), so these don't wait.
      multithread_->Enter();
      const bool ok = context_->GetData(s.disjoint.get(), &dj, sizeof(dj), D3D11_ASYNC_GETDATA_DONOTFLUSH) == S_OK &&
                      context_->GetData(s.start.get(), &t0, sizeof(t0), D3D11_ASYNC_GETDATA_DONOTFLUSH) == S_OK &&
                      context_->GetData(s.stop.get(), &t1, sizeof(t1), D3D11_ASYNC_GETDATA_DONOTFLUSH) == S_OK;
      multithread_->Leave();
      if (ok && !dj.Disjoint && dj.Frequency > 0 && t1 >= t0) {
        record(p.gpu, static_cast<int64_t>(double(t1 - t0) * 1e6 / double(dj.Frequency)));
      } else {
        count("gpuQueryLost");
      }
    } else {
      count("gpuFenceTimeout");
    }
    std::lock_guard lock(mutex_);
    slots_[p.slot].busy = false;
  }
}

} // namespace nexo::profile
