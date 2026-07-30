// ── bindings/wasm/px_wasm.cpp ───────────────────────────────────────────────
// The ONLY file in the project permitted to include <emscripten/*>.
//
// Everything the browser can call lives here, and the surface is capped at
// roughly 20 functions on purpose. embind is the right tool for the control
// plane — a handful of calls per second that need strings and structured
// returns — and the wrong tool for bulk data, where emscripten::val and
// register_vector copy far more than their documentation implies. Bulk paths
// (Phase 3 onward) move through raw pointers into engine-owned buffers
// instead, and never appear in this file's binding list.
// ────────────────────────────────────────────────────────────────────────────
#include <emscripten/bind.h>

#include <string>

#include "px/version.hpp"

namespace {

// embind marshals std::string cleanly to a JS string. Returning const char*
// would bind as a raw pointer and surface in JS as an integer address, which
// is a confusing five minutes the first time it happens.
std::string version() {
  return std::string(px::version());
}

std::string build_target() {
  return std::string(px::build_target());
}

bool has_simd() {
  return px::has_simd();
}

}  // namespace

EMSCRIPTEN_BINDINGS(parallax) {
  emscripten::function("version", &version);
  emscripten::function("buildTarget", &build_target);
  emscripten::function("hasSimd", &has_simd);
}
