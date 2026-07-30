// ── px/prelude.hpp ──────────────────────────────────────────────────────────
// Included by every engine header. Fixed-width aliases, assertions, and the
// error type.
//
// The engine is compiled with -fno-exceptions, so errors travel as values. For
// an analytics engine that is the honest model anyway: a malformed query or an
// out-of-range timestamp is an ordinary result the caller must handle, not an
// exceptional condition. Allocation failure is the one case treated as fatal,
// because there is nothing useful a query executor can do about it.
// ────────────────────────────────────────────────────────────────────────────
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <span>

namespace px {

using u8 = std::uint8_t;
using u16 = std::uint16_t;
using u32 = std::uint32_t;
using u64 = std::uint64_t;
using i8 = std::int8_t;
using i16 = std::int16_t;
using i32 = std::int32_t;
using i64 = std::int64_t;
using f32 = float;
using f64 = double;
using usize = std::size_t;

template <class T>
using Span = std::span<T>;

// ── errors ─────────────────────────────────────────────────────────────────

enum class Code : u32 {
  Ok = 0,
  InvalidArgument,
  OutOfRange,
  Parse,
  Unsupported,
  Corrupt,
  PolicyDenied,
  Internal,
};

// Deliberately trivially copyable and 16 bytes: Status is returned by value
// from hot-ish paths and should never be a reason to reach for a reference.
// `msg` always points at a string literal, never at owned memory — there is no
// lifetime to reason about and no allocation on the error path.
struct Status {
  Code code = Code::Ok;
  const char* msg = "";

  [[nodiscard]] constexpr bool ok() const noexcept { return code == Code::Ok; }
  explicit constexpr operator bool() const noexcept { return ok(); }

  static constexpr Status Ok() noexcept { return {}; }
  static constexpr Status Err(Code c, const char* m) noexcept { return {c, m}; }
};

// ── assertions ─────────────────────────────────────────────────────────────
//
// PX_ASSERT documents an invariant the engine's own code guarantees. It is NOT
// input validation — anything derived from a snapshot file, a query string, or
// a network feed is untrusted and must return a Status instead. An assertion
// that can be triggered by a malformed .pxsnap is a crash-on-bad-input bug,
// not a safety net.
//
// Compiled out under NDEBUG so release benchmarks measure the algorithm.

[[noreturn]] inline void px_assert_fail(const char* expr, const char* file, int line,
                                        const char* msg) noexcept {
  std::fprintf(stderr, "PX_ASSERT failed: %s\n  at %s:%d\n  %s\n", expr, file, line,
               msg ? msg : "");
  std::abort();
}

}  // namespace px

#ifdef NDEBUG
#define PX_ASSERT(expr, msg) ((void)0)
#else
#define PX_ASSERT(expr, msg) \
  ((expr) ? (void)0 : ::px::px_assert_fail(#expr, __FILE__, __LINE__, (msg)))
#endif

// Always evaluated, in every build. For conditions where continuing would
// corrupt memory rather than merely produce a wrong answer.
#define PX_CHECK(expr, msg) \
  ((expr) ? (void)0 : ::px::px_assert_fail(#expr, __FILE__, __LINE__, (msg)))
