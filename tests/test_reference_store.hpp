// ── tests/test_reference_store.hpp ──────────────────────────────────────────
// A deliberately stupid bitemporal store.
//
// This is the most valuable file in the test suite, and it was written BEFORE
// the optimised store in px/store.hpp — on purpose. It is an independent
// definition of what "correct" means, produced without knowing how the fast
// version would be built, so it cannot inherit the fast version's bugs.
//
// It has no indexes, no chunking, no zone maps, no SIMD, and no cleverness of
// any kind. Every query is a linear scan over a vector of structs. It is
// obviously correct by inspection, which is the only property it needs.
//
// The differential test (test_store.cpp) then asserts:
//
//     for any random sequence of assertions and retractions,
//     and any random (T, S),
//     Store::as_of(T, S) == ReferenceStore::as_of(T, S), as sorted sets
//
// That single property catches the entire class of bugs the optimised store is
// prone to and that unit tests reliably miss: zone-map off-by-ones, binary
// search boundary errors, SIMD lane handling at a chunk tail, and retraction
// visibility at the exact transaction where it happened. Those bugs do not
// crash. They return subtly wrong data — which is the worst possible failure
// for this project, because it survives all the way to a demo.
// ────────────────────────────────────────────────────────────────────────────
#pragma once

#include <algorithm>
#include <vector>

#include "px/ids.hpp"
#include "px/prelude.hpp"
#include "px/value.hpp"

namespace px::testing {

struct RefFact {
  u32 entity = 0;
  u32 attr = 0;
  Value value{};
  Timestamp valid_from = 0;
  Timestamp valid_to = 0;
  u32 sys_from = 0;
  u32 sys_to = 0;
  u16 source = 0;
};

class ReferenceStore {
 public:
  /// Returns the row index, which is also the FactId the real store would use.
  /// Both append in the same order, so the ids line up and the differential
  /// test can compare them directly.
  u32 assert_fact(u32 entity, u32 attr, Value value, Timestamp valid_from,
                  Timestamp valid_to, u32 txn, u16 source) {
    facts_.push_back(RefFact{entity, attr, value, valid_from, valid_to, txn,
                             kOpenSystem, source});
    return static_cast<u32>(facts_.size() - 1);
  }

  /// Marks a fact as no longer believed, as of `txn`.
  ///
  /// Retracting an already-retracted fact is a no-op rather than an error.
  /// Sources re-send corrections, and making that idempotent here matches what
  /// the real store must do.
  void retract(u32 fact_index, u32 txn) {
    if (fact_index >= facts_.size()) return;
    if (facts_[fact_index].sys_to != kOpenSystem) return;
    facts_[fact_index].sys_to = txn;
  }

  /// The definition of bitemporal visibility, written as plainly as possible.
  ///
  /// Both intervals are half-open, [from, to). Half-open is what makes
  /// adjacent versions tile the timeline without overlapping or leaving a gap:
  /// a fact valid [0, 10) followed by one valid [10, 20) has exactly one
  /// answer at every instant, including at 10.
  [[nodiscard]] std::vector<u32> as_of(Timestamp valid_at, u32 sys_at) const {
    std::vector<u32> out;
    for (usize i = 0; i < facts_.size(); ++i) {
      const RefFact& f = facts_[i];

      const bool known_then = f.sys_from <= sys_at && sys_at < f.sys_to;
      const bool true_then = f.valid_from <= valid_at && valid_at < f.valid_to;

      if (known_then && true_then) out.push_back(static_cast<u32>(i));
    }
    return out;
  }

  [[nodiscard]] std::vector<u32> as_of_entity(u32 entity, Timestamp valid_at,
                                              u32 sys_at) const {
    std::vector<u32> out;
    for (const u32 i : as_of(valid_at, sys_at)) {
      if (facts_[i].entity == entity) out.push_back(i);
    }
    return out;
  }

  [[nodiscard]] usize size() const noexcept { return facts_.size(); }
  [[nodiscard]] const RefFact& at(usize i) const { return facts_[i]; }

  static constexpr u32 kOpenSystem = 0xFFFF'FFFFu;

 private:
  std::vector<RefFact> facts_;
};

}  // namespace px::testing
