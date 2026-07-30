# ── px_core ─────────────────────────────────────────────────────────────────
# The whole engine, as one static library, built identically for both targets.
#
# Rule enforced by review, not by the build system: nothing under engine/ may
# include <emscripten.h>, a renderer header, or anything that does I/O. The
# engine takes bytes in and writes bytes out. bindings/wasm and native/ are the
# only places allowed to know what platform they are on.
# ────────────────────────────────────────────────────────────────────────────

add_library(px_core STATIC
  src/arena.cpp
  src/geo.cpp
  src/ql/lexer.cpp
  src/ql/parser.cpp
  src/session.cpp
  src/store.cpp
  src/symbols.cpp
  src/version.cpp)

target_include_directories(px_core PUBLIC include)
target_link_libraries(px_core PRIVATE px_warnings)

# Exceptions and RTTI:
#   Exceptions are OFF *for the engine's own translation units*. Errors travel
#   as px::Status values, which is what an analytics engine wants anyway (an
#   unparseable query is an expected result, not an exceptional one) and it
#   keeps the wasm binary meaningfully smaller.
#
#   PRIVATE, not PUBLIC, and that distinction matters: doctest implements
#   REQUIRE by throwing to abort the current test case. Propagating
#   -fno-exceptions to consumers would silently degrade every REQUIRE into a
#   CHECK that keeps running against known-bad state, turning one clear failure
#   into a cascade of confusing ones. The engine stays exception-free; the test
#   harness is allowed to use the language feature it is built on.
#
#   RTTI stays ON — embind requires it, and disabling it fails at link time
#   with an error that reads like anything but "you turned off RTTI".
target_compile_options(px_core PRIVATE -fno-exceptions)

target_compile_definitions(px_core PUBLIC
  PX_VERSION_STRING="${PROJECT_VERSION}")
