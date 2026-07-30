# ── tests ───────────────────────────────────────────────────────────────────
# doctest, vendored as a single header rather than via its own CMake project.
#
# Why not the normal FetchContent_MakeAvailable(doctest): doctest's
# CMakeLists.txt declares cmake_minimum_required(VERSION 3.0), and CMake 4.x
# removed compatibility with anything below 3.5 — it hard-errors before a line
# of doctest is read. Workarounds exist (CMAKE_POLICY_VERSION_MINIMUM), but
# doctest is one self-contained header with no build steps of its own, so
# downloading just the header and wrapping it in an INTERFACE target is both
# simpler and immune to the next policy change.
#
# SYSTEM on the include directory is deliberate: px_warnings turns on
# -Wold-style-cast and -Wconversion, and third-party headers should not have to
# satisfy our house style.
# ────────────────────────────────────────────────────────────────────────────

include(FetchContent)

set(PX_DOCTEST_VERSION "2.4.12")

FetchContent_Declare(doctest_header
  URL      "https://raw.githubusercontent.com/doctest/doctest/v${PX_DOCTEST_VERSION}/doctest/doctest.h"
  URL_HASH SHA256=94029a7d32da24a56249658147dbd2b33ff0b9ed665295cbbaf19aafff5b0ced
  DOWNLOAD_NO_EXTRACT TRUE)
FetchContent_MakeAvailable(doctest_header)

add_library(doctest INTERFACE)
target_include_directories(doctest SYSTEM INTERFACE "${doctest_header_SOURCE_DIR}")

# One binary for every test file. Test binaries are cheap to link and a single
# target means `ctest` gives one clear pass/fail without per-file ceremony.
add_executable(px_tests
  main.cpp
  test_arena.cpp
  test_store.cpp
  test_symbols.cpp
  test_version.cpp)

target_link_libraries(px_tests PRIVATE px_core doctest px_warnings)
target_include_directories(px_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")

add_test(NAME px_tests COMMAND px_tests)

# --no-tests=error stops a broken filter or an empty binary from reporting
# success, which is the failure mode that makes a green CI badge meaningless.
set_tests_properties(px_tests PROPERTIES TIMEOUT 300)
