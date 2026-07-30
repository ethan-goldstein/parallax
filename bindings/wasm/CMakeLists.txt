# ── the WebAssembly target ──────────────────────────────────────────────────
# Produces web/public/wasm/parallax.{js,wasm}.
#
# Output goes to public/ rather than src/ because Vite copies public/ verbatim
# and never runs it through Rollup. The emscripten glue contains conditional
# require('fs') / require('path') calls for its Node backend; Rollup tries to
# statically resolve them, fails, and reports an error that reads like a
# missing dependency rather than "stop bundling this file".
# ────────────────────────────────────────────────────────────────────────────

add_executable(parallax px_wasm.cpp)
target_link_libraries(parallax PRIVATE px_core px_warnings)

# The engine is exception-free; so is the binding layer. RTTI stays on for
# embind.
target_compile_options(parallax PRIVATE -fno-exceptions)

set_target_properties(parallax PROPERTIES
  OUTPUT_NAME "parallax"
  SUFFIX      ".js"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/web/public/wasm")

target_link_options(parallax PRIVATE
  --bind

  # ES module, instantiated explicitly by web/src/engine/boot.ts. MODULARIZE
  # without EXPORT_ES6 emits a CommonJS factory that Vite cannot import.
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createParallax
  -sENVIRONMENT=web

  # Memory. INITIAL_MEMORY is pre-grown to 256 MB so that growth essentially
  # never happens after boot — and growth is worth avoiding hard, because it
  # detaches every ArrayBuffer view JS is holding, with no exception thrown and
  # no symptom beyond reads silently returning undefined. web/src/engine/heap.ts
  # defends against it anyway; this makes it rare enough to be a non-event.
  # WASM pages are lazily committed by the OS, so reserving 256 MB does not
  # cost 256 MB of resident memory.
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=268435456
  -sMAXIMUM_MEMORY=2147483648

  # Default stack is 64 KB. The recursive-descent query parser (Phase 5) and
  # Brandes betweenness (Phase 8) both recurse deeply enough to overflow it,
  # and a wasm stack overflow presents as a generic RuntimeError with no usable
  # trace. 4 MB removes the whole category.
  -sSTACK_SIZE=4194304

  # emmalloc is markedly smaller than dlmalloc and we allocate through arenas
  # rather than hammering malloc, so its weaker fragmentation behaviour under
  # heavy churn does not apply to us.
  -sMALLOC=emmalloc

  # No virtual filesystem: snapshots are fetched by TypeScript and handed to
  # the engine as (ptr, len). Strips ~30 KB of glue we would never call.
  -sFILESYSTEM=0

  -sEXPORTED_FUNCTIONS=['_malloc','_free']

  # Emscripten's heap view names are asymmetric: unsigned views carry a U
  # (HEAPU8/HEAPU16/HEAPU32) but signed ones do not (HEAP8/HEAP16/HEAP32).
  # There is no HEAPI32, and asking for one fails at link time with
  # "undefined exported symbol", not at configure time.
  -sEXPORTED_RUNTIME_METHODS=['HEAP8','HEAPU8','HEAP16','HEAPU16','HEAP32','HEAPU32','HEAPF32','HEAPF64']

  -sINCOMING_MODULE_JS_API=['locateFile'])

# Release-only link flags. -O3 at link time is what runs Binaryen's optimiser
# over the whole module; setting it only on compile leaves most of it on the
# table.
target_link_options(parallax PRIVATE $<$<CONFIG:Release>:-O3>)
target_compile_options(parallax PRIVATE $<$<CONFIG:Release>:-O3>)

# Debug builds: ASSERTIONS turns opaque RuntimeErrors into readable messages,
# and SAFE_HEAP catches misaligned and out-of-bounds heap access — the exact
# class of bug the JS<->WASM boundary produces. It is roughly 10x slower, which
# is why it is a separate preset rather than the default.
target_compile_options(parallax PRIVATE $<$<CONFIG:Debug>:-O0>)
target_link_options(parallax PRIVATE
  $<$<CONFIG:Debug>:-O0>
  $<$<CONFIG:Debug>:-g3>
  $<$<CONFIG:Debug>:-sASSERTIONS=2>
  $<$<CONFIG:Debug>:-sSAFE_HEAP=1>
  $<$<CONFIG:Debug>:-sSTACK_OVERFLOW_CHECK=2>)
