#include <doctest.h>

#include <cstring>

#include "px/version.hpp"

// Phase 1 has nothing worth asserting about behaviour yet. What these tests
// actually verify is that the test harness itself is wired up: that px_core
// links, that headers resolve, and that `ctest` fails the build when an
// assertion fails. A test suite you have never seen go red is not a test suite.

TEST_CASE("version is a non-empty string") {
  const char* v = px::version();
  REQUIRE(v != nullptr);
  CHECK(std::strlen(v) > 0);
}

TEST_CASE("build_target reports native when compiled natively") {
  // px_tests is native-only, so this doubles as a check that the preprocessor
  // branch in version.cpp is wired the way we think it is.
  CHECK(std::strcmp(px::build_target(), "native") == 0);
}

TEST_CASE("has_simd is callable and does not crash") {
  const bool simd = px::has_simd();
  CHECK((simd == true || simd == false));
}
