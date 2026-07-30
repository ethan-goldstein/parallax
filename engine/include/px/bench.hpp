// ── px/bench.hpp ────────────────────────────────────────────────────────────
// Timing that compiles into BOTH targets.
//
// This is the file that makes the in-UI benchmark panel credible. Because the
// same header is used natively and under emscripten, the browser runs the
// identical measurement code as the committed benchmark table — not a
// TypeScript reimplementation that could differ in what it counts.
//
// The single #ifdef in the project that branches on the platform lives here,
// deliberately, so the rest of engine/ stays platform-agnostic.
// ────────────────────────────────────────────────────────────────────────────
#pragma once

#include "px/prelude.hpp"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
#include <chrono>
#endif

namespace px {

/// Monotonic wall clock in milliseconds. Origin is arbitrary — only
/// differences are meaningful.
///
/// emscripten_get_now() is backed by performance.now(), which browsers
/// deliberately coarsen (typically to ~100 microseconds, more under some
/// isolation settings) as a Spectre mitigation. Anything shorter than about a
/// millisecond must therefore be measured by running it N times and dividing,
/// never by timing one iteration.
[[nodiscard]] inline f64 now_ms() noexcept {
#ifdef __EMSCRIPTEN__
  return emscripten_get_now();
#else
  const auto t = std::chrono::steady_clock::now().time_since_epoch();
  return std::chrono::duration<f64, std::milli>(t).count();
#endif
}

/// Scoped timer. Writes elapsed milliseconds to `out` on destruction.
class ScopedTimer {
 public:
  explicit ScopedTimer(f64& out) noexcept : out_(out), start_(now_ms()) {}
  ~ScopedTimer() { out_ = now_ms() - start_; }

  ScopedTimer(const ScopedTimer&) = delete;
  ScopedTimer& operator=(const ScopedTimer&) = delete;

 private:
  f64& out_;
  f64 start_;
};

}  // namespace px
