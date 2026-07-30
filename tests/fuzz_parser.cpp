// ── tests/fuzz_parser.cpp ───────────────────────────────────────────────────
// libFuzzer entry point for the query parser.
//
// A parser is the one component in this project that consumes genuinely
// arbitrary input — a user types into a box. Hand-written tests cover the
// shapes I thought of; the fuzzer covers the ones I did not, which is where
// parser bugs actually live.
//
// It found nothing on the first run only because the depth guard had already
// been added — before that, 200 nested parentheses segfaulted, and a fuzzer
// reaches that in seconds. That is the class of bug this exists for.
//
// The contract being asserted is narrow and total: for ANY byte sequence,
// parse() returns. It may succeed, it may report an error, but it may not
// crash, hang, read out of bounds, or overflow the stack. ASan and UBSan are
// linked in, so a violation aborts rather than passing quietly.
//
// Run locally:
//   cmake --preset fuzz && cmake --build --preset fuzz
//   ./build/fuzz/tests/fuzz_parser -max_total_time=60
// ────────────────────────────────────────────────────────────────────────────
#include <cstddef>
#include <cstdint>
#include <string_view>

#include "px/ql/parser.hpp"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  const std::string_view src(reinterpret_cast<const char*>(data), size);

  px::ql::ParseResult r = px::ql::parse(src);

  // Touch the results so the optimiser cannot delete the parse entirely.
  // Without this, LTO can prove the call has no observable effect and the
  // fuzzer spends its budget measuring an empty loop.
  volatile size_t sink = r.query.nodes.size() + r.query.strings.size() +
                         r.error.message.size() + (r.error.failed ? 1u : 0u);
  (void)sink;

  // An invariant worth asserting beyond "did not crash": a reported error must
  // carry a span inside the input, or the UI would underline nothing — or
  // worse, read past the end of the string it is highlighting.
  if (r.error.failed) {
    if (r.error.begin > size || r.error.end > size || r.error.end < r.error.begin) {
      __builtin_trap();
    }
  }

  return 0;
}
