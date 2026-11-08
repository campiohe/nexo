#pragma once
// Something that fills a FrameRing: WGC capture or the synthetic test pattern.

#include <functional>
#include <string>

#include "video/output_size.hpp"

namespace nexo {

class FrameSource {
 public:
  virtual ~FrameSource() = default;

  /// Content size at share start (picks the output size, SPEC-BETA §4.5).
  virtual Size initialSize() const = 0;
  virtual void start() = 0;
  /// Stops delivering frames. Blocks until no callback is running. Idempotent.
  virtual void stop() = 0;

  /// SPEC-BETA §4.4: a minimized window delivers nothing; the UI says so from stats.stalled. Static content on a
  /// monitor is not stalled.
  virtual bool stalled(int64_t nowUs) const = 0;
  /// The source is gone for good (window closed). Checked by the encode loop.
  virtual bool closed() const = 0;

  virtual void setCursor(bool /*enabled*/) {}
  virtual void setFrameRate(double /*fps*/) {}

  virtual std::string describe() const = 0;
};

} // namespace nexo
