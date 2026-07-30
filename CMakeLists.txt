# ── PARALLAX ────────────────────────────────────────────────────────────────
# One engine, two targets. `engine/` is pure C++20 with no knowledge of
# emscripten, HTTP, JSON, or a renderer — that constraint is what makes the
# native tests meaningful for the WASM build rather than a parallel universe.
#
#   native  →  px_tests, px_bench, px_cli, px_snapshot, fuzz_parser
#   wasm    →  parallax.js + parallax.wasm  (bindings/wasm only)
# ────────────────────────────────────────────────────────────────────────────
cmake_minimum_required(VERSION 3.24)

project(parallax
  VERSION      0.1.0
  DESCRIPTION  "Bitemporal analytical engine for open-source intelligence"
  LANGUAGES    CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Ship compile_commands.json so clangd works without extra setup.
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")
include(Warnings)

# EMSCRIPTEN is set by the emscripten toolchain file; everything downstream
# branches on it rather than on a hand-rolled option.
if(EMSCRIPTEN)
  message(STATUS "PARALLAX: building the WebAssembly target")

  # WASM SIMD, applied to every translation unit rather than to one target,
  # because the code that benefits (the store's visibility predicate) lives in
  # px_core while the link happens in bindings/wasm.
  #
  # Shipping SIMD unconditionally is a deliberate call: it has been supported
  # in every major browser since Safari 16.4 in March 2023, and maintaining a
  # scalar fallback build would double the CI matrix to serve browsers that
  # cannot run the rest of this application anyway. boot.ts feature-detects and
  # shows a readable message instead of a stack trace.
  add_compile_options(-msimd128)
else()
  message(STATUS "PARALLAX: building the native target")
endif()

add_subdirectory(engine)

if(EMSCRIPTEN)
  add_subdirectory(bindings/wasm)
else()
  add_subdirectory(native)

  # Tests are native-only on purpose: they exercise px_core, which is the same
  # translation units the wasm target links. A browser test harness would cost
  # a lot and prove less. The cross-target consistency check (Phase 8) is what
  # closes the remaining gap.
  include(CTest)
  if(BUILD_TESTING)
    add_subdirectory(tests)
  endif()
endif()
