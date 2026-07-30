#include "px/version.hpp"

namespace px {

const char* version() noexcept {
  return PX_VERSION_STRING;
}

const char* build_target() noexcept {
#ifdef __EMSCRIPTEN__
  return "wasm";
#else
  return "native";
#endif
}

bool has_simd() noexcept {
  // __wasm_simd128__ is defined by clang when -msimd128 is in effect. On the
  // native target this is always false today; the native build gets its own
  // vectorisation from the host compiler and reports separately in the bench
  // table, so conflating the two here would make the numbers lie.
#ifdef __wasm_simd128__
  return true;
#else
  return false;
#endif
}

}  // namespace px
