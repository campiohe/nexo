#include <chrono>

#include "common/log.hpp"
#include "common/win_error.hpp"
#include "publish/publisher.hpp"

namespace nexo {
namespace {

class NullPublisher final : public Publisher {
 public:
  explicit NullPublisher(PublisherCallbacks callbacks) : callbacks_(std::move(callbacks)) {
    // Test lever: pretend a viewer asks for a keyframe every N ms, to check forced IDRs without LiveKit.
    if (auto ms = envString("NEXO_MEDIA_FAKE_PLI_MS"); !ms.empty()) {
      try {
        fakePli_ = std::chrono::milliseconds(std::stoi(ms));
      } catch (...) {
      }
    }
  }

  void connect(const std::string&, const std::string&) override {
    log::info("publish: dry run, frames are encoded and discarded (no LiveKit)");
  }
  void publishVideo(const VideoTrackConfig& c) override {
    log::info("publish: dry run track {}x{}@{} max {} kbps", c.width, c.height, c.fps, c.maxBitrate / 1000);
  }
  bool sendVideo(EncodedFrame&&) override { return true; }
  PublishFeedback takeFeedback() override {
    PublishFeedback fb;
    if (fakePli_.count() > 0) {
      const auto now = std::chrono::steady_clock::now();
      if (now - lastPli_ >= fakePli_) {
        lastPli_ = now;
        fb.keyframeRequested = true;
      }
    }
    return fb;
  }
  void publishAudio() override { log::info("publish: dry run audio track 48 kHz stereo"); }
  bool sendAudio(std::span<const int16_t>) override { return true; }
  void close() override {}
  void detachCallbacks() override {}
  std::string describe() const override { return "dry run"; }

 private:
  PublisherCallbacks callbacks_;
  std::chrono::milliseconds fakePli_{0};
  std::chrono::steady_clock::time_point lastPli_ = std::chrono::steady_clock::now();
};

} // namespace

std::unique_ptr<Publisher> createNullPublisher(PublisherCallbacks callbacks) {
  return std::make_unique<NullPublisher>(std::move(callbacks));
}

} // namespace nexo
