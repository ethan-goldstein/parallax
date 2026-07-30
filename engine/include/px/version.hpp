// ── px/version.hpp ──────────────────────────────────────────────────────────
// Deliberately the only thing px_core exports in Phase 1.
//
// The walking skeleton exists to prove one claim end to end before any real
// code depends on it: that a C++ translation unit can be compiled by
// emscripten, linked through embind, loaded by Vite under a GitHub Pages
// subpath, and called from TypeScript. Every one of those five seams has a
// well-known failure mode. Finding them now costs an afternoon; finding them
// after the engine exists costs the project.
// ────────────────────────────────────────────────────────────────────────────
#pragma once

namespace px {

// Semantic version of the engine, injected from the CMake project version so
// there is exactly one place it can be wrong.
const char* version() noexcept;

// Which target compiled this binary: "native" or "wasm". The web UI displays
// it, which makes "am I actually running the WebAssembly build, or a stale
// cached bundle?" a question you can answer by looking rather than guessing.
const char* build_target() noexcept;

// Reports whether the binary was compiled with WASM SIMD enabled. The store's
// visibility predicate (Phase 2) is written scalar first and vectorised second,
// and the benchmark panel needs to label which one it measured.
bool has_simd() noexcept;

}  // namespace px
