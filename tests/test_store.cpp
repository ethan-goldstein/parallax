#include <algorithm>
#include <random>
#include <vector>

#include <doctest.h>

#include "px/store.hpp"
#include "test_reference_store.hpp"

using namespace px;

namespace {

std::vector<u32> to_indices(const std::vector<FactId>& v) {
  std::vector<u32> out;
  out.reserve(v.size());
  for (const FactId f : v) out.push_back(f.v);
  std::sort(out.begin(), out.end());
  return out;
}

}  // namespace

// ── hand-written cases ─────────────────────────────────────────────────────
// These document the semantics. The differential test below is what actually
// finds bugs, but a failing property test tells you *that* something is wrong;
// these tell you *what*.

TEST_CASE("half-open valid intervals tile without overlap or gap") {
  Store s;
  const SymbolId attr = s.symbols().intern("magnitude");
  const EntityId e{1};

  s.begin_txn(1000);
  s.assert_fact(e, attr, Value::real(5.8), 0, 10, SourceId{0});
  s.assert_fact(e, attr, Value::real(6.4), 10, kOpenValid, SourceId{0});
  s.commit_txn();

  const TxnId now = s.current_txn();

  auto at = [&](Timestamp t) {
    std::vector<FactId> out;
    s.as_of(t, now, out);
    return out;
  };

  CHECK(at(9).size() == 1);
  CHECK(s.fact_value(at(9)[0]).as_f64() == doctest::Approx(5.8));

  // The boundary. At exactly t=10 the first interval has ended (exclusive end)
  // and the second has begun (inclusive start) — one answer, not zero, not two.
  REQUIRE(at(10).size() == 1);
  CHECK(s.fact_value(at(10)[0]).as_f64() == doctest::Approx(6.4));

  CHECK(at(-1).empty());
}

TEST_CASE("retraction hides a fact from later transactions but not earlier ones") {
  Store s;
  const SymbolId attr = s.symbols().intern("position");
  const EntityId e{7};

  s.begin_txn(1000);
  const FactId f = s.assert_fact(e, attr, Value::integer(42), 0, kOpenValid, SourceId{0});
  s.commit_txn();
  const TxnId t1 = s.current_txn();

  s.begin_txn(2000);
  s.retract(f);
  s.commit_txn();
  const TxnId t2 = s.current_txn();

  std::vector<FactId> before, after;
  s.as_of(5, t1, before);
  s.as_of(5, t2, after);

  // This is the whole product in four lines: the fact is still visible at the
  // system time when we believed it, and invisible at the system time after we
  // stopped. Scrubbing the system axis backwards recovers the old belief.
  CHECK(before.size() == 1);
  CHECK(after.empty());
}

TEST_CASE("retraction is idempotent") {
  Store s;
  const SymbolId attr = s.symbols().intern("x");

  s.begin_txn(1000);
  const FactId f = s.assert_fact(EntityId{1}, attr, Value::integer(1), 0, kOpenValid,
                                 SourceId{0});
  s.commit_txn();

  s.begin_txn(2000);
  s.retract(f);
  s.commit_txn();
  const u32 first = s.fact_sys_to(f);

  // A feed re-sending a correction must not rewrite when we stopped believing
  // the original — that would move a point on the system axis backwards.
  s.begin_txn(3000);
  s.retract(f);
  s.commit_txn();

  CHECK(s.fact_sys_to(f) == first);
}

TEST_CASE("transaction 0 is empty by construction") {
  Store s;
  s.begin_txn(1000);
  s.assert_fact(EntityId{1}, s.symbols().intern("a"), Value::integer(1), 0, kOpenValid,
                SourceId{0});
  s.commit_txn();

  std::vector<FactId> out;
  s.as_of(0, TxnId{0}, out);

  // The scrubber's leftmost system position must mean "before we knew
  // anything" rather than being an error the UI has to special-case.
  CHECK(out.empty());
}

// ── the differential test ──────────────────────────────────────────────────

TEST_CASE("differential: optimised store agrees with the naive oracle") {
  // Fixed seed: a property test that fails only sometimes is nearly useless,
  // because you cannot tell a fix from luck. When this does fail, the seed and
  // the operation log reproduce it exactly.
  std::mt19937 rng(0xC0FFEEu);

  constexpr int kTrials = 40;
  constexpr int kOpsPerTrial = 700;
  constexpr int kProbesPerTrial = 60;

  // Deliberately tiny domains. Collisions are the point — overlapping valid
  // intervals on the same entity and attribute are what produce boundary bugs,
  // and wide random ranges almost never generate them.
  std::uniform_int_distribution<int> entity_dist(0, 12);
  std::uniform_int_distribution<int> attr_dist(0, 3);
  std::uniform_int_distribution<int> time_dist(-20, 60);
  std::uniform_int_distribution<int> op_dist(0, 99);

  for (int trial = 0; trial < kTrials; ++trial) {
    Store fast;
    testing::ReferenceStore ref;

    std::vector<u32> live;  // fact ids that have not been retracted yet
    std::vector<SymbolId> attrs;
    for (int a = 0; a < 4; ++a) {
      attrs.push_back(fast.symbols().intern("attr" + std::to_string(a)));
    }

    int ops = 0;
    while (ops < kOpsPerTrial) {
      // Several operations per transaction, which is what a real feed batch
      // looks like and which exercises facts sharing a sys_from.
      const int batch = 1 + (op_dist(rng) % 8);
      fast.begin_txn(1000 + ops);
      const u32 txn = fast.current_txn().v;

      for (int k = 0; k < batch && ops < kOpsPerTrial; ++k, ++ops) {
        if (op_dist(rng) < 22 && !live.empty()) {
          std::uniform_int_distribution<usize> pick(0, live.size() - 1);
          const usize idx = pick(rng);
          const u32 target = live[idx];

          fast.retract(FactId{target});
          ref.retract(target, txn);

          live[idx] = live.back();
          live.pop_back();
        } else {
          int from = time_dist(rng);
          int to = time_dist(rng);
          if (to < from) std::swap(to, from);

          // Mix in open-ended intervals: "still true" is the common case in
          // live data and uses the kOpenValid sentinel path.
          const bool open_ended = (op_dist(rng) < 30);
          const Timestamp valid_to = open_ended ? kOpenValid : static_cast<Timestamp>(to);

          const int e = entity_dist(rng);
          const int a = attr_dist(rng);
          const Value v = Value::integer(ops);

          const FactId got = fast.assert_fact(EntityId{static_cast<u32>(e)},
                                              attrs[static_cast<usize>(a)], v,
                                              static_cast<Timestamp>(from), valid_to,
                                              SourceId{0});
          const u32 expect = ref.assert_fact(static_cast<u32>(e), static_cast<u32>(a), v,
                                             static_cast<Timestamp>(from), valid_to, txn, 0);

          // Both stores must assign the same row index, or the comparison
          // below would be meaningless.
          REQUIRE(got.v == expect);
          live.push_back(got.v);
        }
      }
      fast.commit_txn();
    }

    fast.rebuild_entity_index();

    const u32 max_txn = fast.current_txn().v;
    std::uniform_int_distribution<u32> sys_dist(0, max_txn);

    for (int p = 0; p < kProbesPerTrial; ++p) {
      const auto valid_at = static_cast<Timestamp>(time_dist(rng));
      const u32 sys_at = sys_dist(rng);

      std::vector<FactId> got;
      ScanStats stats{};
      fast.as_of(valid_at, TxnId{sys_at}, got, &stats);

      const std::vector<u32> expected = ref.as_of(valid_at, sys_at);
      const std::vector<u32> actual = to_indices(got);

      INFO("trial=", trial, " valid_at=", valid_at, " sys_at=", sys_at,
           " expected=", expected.size(), " actual=", actual.size(),
           " chunks_skipped=", stats.chunks_skipped);
      REQUIRE(actual == expected);

      // The entity index must agree with the scan it is meant to accelerate.
      // An index that is fast and wrong is worse than no index at all.
      const auto probe_entity = static_cast<u32>(entity_dist(rng));
      std::vector<FactId> got_e;
      fast.as_of_entity(EntityId{probe_entity}, valid_at, TxnId{sys_at}, got_e);

      const std::vector<u32> expected_e = ref.as_of_entity(probe_entity, valid_at, sys_at);
      const std::vector<u32> actual_e = to_indices(got_e);

      INFO("entity probe: entity=", probe_entity);
      REQUIRE(actual_e == expected_e);
    }
  }
}

TEST_CASE("differential: zone maps actually skip chunks at scale") {
  // A correctness test that passes trivially because no chunk was ever skipped
  // would give false confidence in the index. This forces multiple chunks and
  // asserts the skip path is exercised *and* still correct.
  Store fast;
  testing::ReferenceStore ref;
  const SymbolId attr = fast.symbols().intern("v");

  constexpr u32 kRows = kChunkRows * 5 + 137;  // deliberately not chunk-aligned

  fast.begin_txn(1);
  const u32 txn = fast.current_txn().v;
  for (u32 i = 0; i < kRows; ++i) {
    // Valid intervals march forward, so any single instant lands inside only a
    // couple of chunks and the rest are provably skippable.
    const auto from = static_cast<Timestamp>(i);
    const auto to = static_cast<Timestamp>(i + 50);
    fast.assert_fact(EntityId{i % 64}, attr, Value::integer(i), from, to, SourceId{0});
    ref.assert_fact(i % 64, attr.v, Value::integer(i), from, to, txn, 0);
  }
  fast.commit_txn();

  const TxnId now = fast.current_txn();

  for (const Timestamp probe : {Timestamp{100}, Timestamp{20000}, Timestamp{41000}}) {
    std::vector<FactId> got;
    ScanStats stats{};
    fast.as_of(probe, now, got, &stats);

    INFO("probe=", probe, " skipped=", stats.chunks_skipped, "/", stats.chunks_total);
    CHECK(stats.chunks_skipped > 0);
    REQUIRE(to_indices(got) == ref.as_of(probe, now.v));
  }
}
