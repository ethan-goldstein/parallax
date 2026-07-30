#include <cstdint>

#include <doctest.h>

#include "px/arena.hpp"

using namespace px;

TEST_CASE("allocations are aligned") {
  Arena a(4096);
  (void)a.alloc(1, 1);  // knock the head off an aligned boundary

  void* p8 = a.alloc(8, 8);
  void* p16 = a.alloc(4, 16);

  REQUIRE(p8 != nullptr);
  REQUIRE(p16 != nullptr);
  CHECK(reinterpret_cast<std::uintptr_t>(p8) % 8 == 0);
  CHECK(reinterpret_cast<std::uintptr_t>(p16) % 16 == 0);
}

TEST_CASE("exhaustion returns nullptr instead of growing") {
  Arena a(128);
  CHECK(a.alloc(64, 8) != nullptr);

  // The arena must never grow: growing would move every live allocation while
  // callers still hold pointers into the old block. Reporting exhaustion lets
  // a query truncate its result set, which is recoverable.
  CHECK(a.alloc(1024, 8) == nullptr);

  // A failed allocation must not consume capacity, or repeated failures would
  // leak the arena away.
  CHECK(a.alloc(32, 8) != nullptr);
}

TEST_CASE("mark and release rewind the head") {
  Arena a(4096);
  (void)a.alloc(100, 8);

  const usize mark = a.mark();
  void* first = a.alloc(500, 8);
  const usize after_first = a.used();
  REQUIRE(first != nullptr);
  CHECK(a.used() > mark);

  a.release(mark);
  CHECK(a.used() == mark);

  // Post-release allocation reuses the same region — this is the per-query
  // scratch pattern, where freeing every intermediate is one assignment.
  //
  // Assert on the returned pointer, not on used(). The head after release sits
  // wherever the previous allocation left it, which need not be aligned, so
  // the next aligned allocation may pad and used() lands a few bytes past
  // mark + size. Pointer identity is the property that actually matters and it
  // does not depend on the alignment arithmetic.
  void* reused = a.alloc(500, 8);
  CHECK(reused == first);
  CHECK(a.used() == after_first);
}

TEST_CASE("peak survives release") {
  Arena a(4096);
  (void)a.alloc(1000, 8);
  const usize peak = a.peak();
  a.release(0);

  // Reported in EXPLAIN so an arena that is chronically too small shows up as
  // a number, rather than as an intermittent nullptr under load.
  CHECK(a.peak() == peak);
  CHECK(a.used() == 0);
}

TEST_CASE("alloc_array rejects counts that would overflow the byte size") {
  Arena a(4096);
  CHECK(a.alloc_array<u64>(SIZE_MAX / 4) == nullptr);
  CHECK(a.alloc_array<u32>(0) == nullptr);
  CHECK(a.alloc_array<u32>(16) != nullptr);
}

TEST_CASE("zero-capacity arena is usable and always fails allocation") {
  Arena a;
  CHECK(a.capacity() == 0);
  CHECK(a.alloc(1, 1) == nullptr);
}

TEST_CASE("move transfers ownership without double free") {
  Arena a(1024);
  void* p = a.alloc(64, 8);
  REQUIRE(p != nullptr);

  Arena b(std::move(a));
  CHECK(b.capacity() == 1024);
  CHECK(b.used() == 64);

  // ASan in the debug preset is what makes this test meaningful — a
  // double-free on scope exit would be reported rather than silently working.
  CHECK(a.capacity() == 0);  // NOLINT(bugprone-use-after-move) — intentional
  CHECK(a.alloc(1, 1) == nullptr);
}
