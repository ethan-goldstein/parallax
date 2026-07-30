// ── px/arena.hpp ────────────────────────────────────────────────────────────
// Bump allocator with mark/release.
//
// Two arenas exist in the engine, with different lifetimes:
//
//   store arena  — lives as long as the store. Holds the interned string blob.
//   query arena  — rewound to a mark after every query, which frees every
//                  intermediate the executor produced in a single pointer
//                  assignment.
//
// Query execution allocates constantly (candidate row lists, hash buckets,
// frontier buffers) and every one of those allocations has exactly the same
// lifetime: the query. That is the case a bump allocator is for. It also keeps
// the hot path off malloc entirely, which matters more under emscripten's
// emmalloc than it does natively.
// ────────────────────────────────────────────────────────────────────────────
#pragma once

#include <limits>

#include "px/prelude.hpp"

namespace px {

class Arena {
 public:
  Arena() noexcept = default;
  explicit Arena(usize capacity_bytes);
  ~Arena();

  // Non-copyable, movable. Copying an arena would mean copying every live
  // allocation's backing store while every index into it still refers to the
  // original — an easy mistake to make and an unpleasant one to debug.
  Arena(const Arena&) = delete;
  Arena& operator=(const Arena&) = delete;
  Arena(Arena&& other) noexcept;
  Arena& operator=(Arena&& other) noexcept;

  /// Returns nullptr when the arena is exhausted. Callers must check: the
  /// arena never grows, by design, because growing would move every live
  /// allocation and invalidate any pointer the caller is holding.
  [[nodiscard]] void* alloc(usize bytes, usize align) noexcept;

  template <class T>
  [[nodiscard]] T* alloc_array(usize count) noexcept {
    if (count == 0) return nullptr;

    // Overflow check before the multiply. `count` derives from cardinality
    // estimates, which derive from data, so it is untrusted.
    //
    // Bounded against SIZE_MAX rather than a hand-picked constant, because
    // usize is 64-bit natively and 32-bit under wasm32. A literal large enough
    // to be a sensible guard on one target is either an overflow or uselessly
    // permissive on the other — this expression is correct on both.
    if (count > std::numeric_limits<usize>::max() / sizeof(T)) return nullptr;
    return static_cast<T*>(alloc(count * sizeof(T), alignof(T)));
  }

  /// Save/restore point. Cheap enough to take per query stage.
  [[nodiscard]] usize mark() const noexcept { return head_; }

  /// Rewinds to a mark. Every pointer handed out since that mark is dangling
  /// afterwards — that is the entire point, and it is why arena-allocated
  /// memory never escapes the scope that rewinds it.
  void release(usize mark) noexcept;

  void reset() noexcept { head_ = 0; }

  [[nodiscard]] usize used() const noexcept { return head_; }
  [[nodiscard]] usize capacity() const noexcept { return cap_; }
  [[nodiscard]] usize remaining() const noexcept { return cap_ - head_; }

  /// High-water mark since construction. Surfaced in EXPLAIN so an arena that
  /// is chronically too small shows up as a number rather than as an
  /// intermittent nullptr under load.
  [[nodiscard]] usize peak() const noexcept { return peak_; }

 private:
  u8* base_ = nullptr;
  usize cap_ = 0;
  usize head_ = 0;
  usize peak_ = 0;
};

}  // namespace px
