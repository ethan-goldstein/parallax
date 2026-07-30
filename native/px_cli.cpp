// ── px_cli ──────────────────────────────────────────────────────────────────
// Headless driver for the engine. In Phase 1 it reports what it was built
// from, which is enough to answer "did the native and wasm targets actually
// compile the same source revision?" without opening a browser.
// ────────────────────────────────────────────────────────────────────────────
#include <cstdio>

#include "px/version.hpp"

int main() {
  std::printf("parallax %s (%s, simd=%s)\n", px::version(), px::build_target(),
              px::has_simd() ? "yes" : "no");
  return 0;
}
