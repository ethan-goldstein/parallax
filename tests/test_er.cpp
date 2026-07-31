#include <algorithm>
#include <random>
#include <string>
#include <vector>

#include <doctest.h>

#include "px/er.hpp"
#include "px/symbols.hpp"

using namespace px;
using namespace px::er;

namespace {

/// Builds a record the way the ingest layer will.
Record rec(u32 id, u16 source, f64 lat, f64 lon, i32 time, f64 mag, SymbolId label = {}) {
  Record r;
  r.id = id;
  r.source = source;
  r.position = GeoPoint::from_degrees(lat, lon);
  r.time = time;
  r.magnitude = mag;
  r.has_magnitude = true;
  r.label = label;
  return r;
}

/// Brute-force clustering oracle: transitive closure of "score >= threshold"
/// computed by repeated relaxation. Obviously correct, quadratic, no
/// union-find — so it cannot inherit union-find's bugs.
std::vector<std::vector<u32>> brute_clusters(const Resolution& res, u32 n) {
  std::vector<u32> label(n);
  for (u32 i = 0; i < n; ++i) label[i] = i;

  bool changed = true;
  while (changed) {
    changed = false;
    for (const Pair& p : res.accepted) {
      const u32 lo = std::min(label[p.a], label[p.b]);
      if (label[p.a] != lo) { label[p.a] = lo; changed = true; }
      if (label[p.b] != lo) { label[p.b] = lo; changed = true; }
    }
  }

  std::vector<std::vector<u32>> out;
  std::vector<u32> seen(n, 0xFFFF'FFFFu);
  for (u32 i = 0; i < n; ++i) {
    if (seen[label[i]] == 0xFFFF'FFFFu) {
      seen[label[i]] = static_cast<u32>(out.size());
      out.emplace_back();
    }
    out[seen[label[i]]].push_back(i);
  }
  for (auto& c : out) std::sort(c.begin(), c.end());
  std::sort(out.begin(), out.end());
  return out;
}

}  // namespace

// ── Jaro-Winkler ───────────────────────────────────────────────────────────

TEST_CASE("jaro-winkler behaves on the cases that matter") {
  CHECK(jaro_winkler("", "") == doctest::Approx(1.0));
  CHECK(jaro_winkler("abc", "") == doctest::Approx(0.0));
  CHECK(jaro_winkler("SOUTHERN ITALY", "SOUTHERN ITALY") == doctest::Approx(1.0));

  // Shared prefix is rewarded — the case region labels actually present.
  CHECK(jaro_winkler("SOUTHERN ITALY", "SOUTHERN ITALY, TYRRHENIAN SEA") > 0.8);
  // Unrelated names must score low or the weakest signal becomes noise.
  CHECK(jaro_winkler("SOUTHERN ITALY", "OFF COAST OF JAPAN") < 0.6);
  // Classic transposition case.
  CHECK(jaro_winkler("MARTHA", "MARHTA") == doctest::Approx(0.961).epsilon(0.01));
}

// ── union-find ─────────────────────────────────────────────────────────────

TEST_CASE("union-find is transitive and idempotent") {
  UnionFind uf(6);
  CHECK(uf.unite(0, 1));
  CHECK(uf.unite(1, 2));
  CHECK_FALSE(uf.unite(0, 2));  // already connected

  CHECK(uf.find(0) == uf.find(2));
  CHECK(uf.find(0) != uf.find(3));
}

TEST_CASE("union-find stays shallow under a chain of merges") {
  // Without union by rank this degenerates into a linked list and find()
  // becomes O(n). 10k sequential unions would then be 50M pointer hops.
  UnionFind uf(10'000);
  for (u32 i = 1; i < 10'000; ++i) uf.unite(i - 1, i);
  for (u32 i = 0; i < 10'000; ++i) CHECK(uf.find(i) == uf.find(0));
}

// ── the real problem ───────────────────────────────────────────────────────

TEST_CASE("cross-agency duplicates merge, distinct events do not") {
  SymbolTable syms;
  const SymbolId italy = syms.intern("SOUTHERN ITALY");
  const SymbolId italy2 = syms.intern("SOUTHERN ITALY, TYRRHENIAN SEA");
  const SymbolId japan = syms.intern("OFF EAST COAST OF HONSHU JAPAN");

  std::vector<Record> records{
      // The same quake as USGS (source 0) and EMSC (source 1) see it: 12 km
      // apart, 4 s apart, 0.2 magnitude units apart. This is what real
      // cross-network disagreement looks like.
      rec(0, 0, 38.4528, 16.0093, 1000, 2.1, italy),
      rec(1, 1, 38.5100, 15.9500, 1004, 2.3, italy2),

      // A genuinely different quake: same region, but 40 minutes later.
      rec(2, 0, 38.4600, 16.0100, 3400, 3.0, italy),

      // A different quake entirely, on the other side of the world.
      rec(3, 1, 38.2000, 142.3000, 1002, 5.4, japan),
  };

  const Resolution res = resolve(records, ErConfig{}, &syms);

  INFO("pairs compared=", res.stats.pairs_compared,
       " accepted=", res.stats.pairs_accepted, " clusters=", res.stats.clusters);

  // 0 and 1 are the same quake.
  CHECK(res.cluster_of[0] == res.cluster_of[1]);
  // 2 is 40 minutes later — the time comparator must veto it despite being
  // 1 km away and in the same region.
  CHECK(res.cluster_of[0] != res.cluster_of[2]);
  // 3 is 11,000 km away.
  CHECK(res.cluster_of[0] != res.cluster_of[3]);

  CHECK(res.stats.clusters == 3);
}

TEST_CASE("same-source records never merge") {
  // Two USGS ids are two quakes by construction — the agency already resolved
  // its own catalogue. Merging them would be a false positive by definition,
  // even at identical coordinates and times.
  std::vector<Record> records{
      rec(0, 0, 10.0, 20.0, 500, 4.0),
      rec(1, 0, 10.0, 20.0, 500, 4.0),
  };
  const Resolution res = resolve(records, ErConfig{}, nullptr);
  CHECK(res.cluster_of[0] != res.cluster_of[1]);
  CHECK(res.stats.pairs_compared == 0);
}

TEST_CASE("no single field can force a merge") {
  // Identical position, but 10 minutes apart. Geo agreement alone (3.2) must
  // not clear the threshold (5.0) once time disagreement (-5.0) applies.
  std::vector<Record> records{
      rec(0, 0, 10.0, 20.0, 0, 4.0),
      rec(1, 1, 10.0, 20.0, 600, 4.0),
  };
  const Resolution res = resolve(records, ErConfig{}, nullptr);
  CHECK(res.cluster_of[0] != res.cluster_of[1]);
}

TEST_CASE("evidence explains every accepted merge") {
  SymbolTable syms;
  std::vector<Record> records{
      rec(0, 0, 38.45, 16.00, 1000, 2.1, syms.intern("SOUTHERN ITALY")),
      rec(1, 1, 38.46, 16.01, 1002, 2.2, syms.intern("SOUTHERN ITALY")),
  };
  const Resolution res = resolve(records, ErConfig{}, &syms);

  REQUIRE(res.accepted.size() == 1);
  const Pair& p = res.accepted[0];

  // The evidence is the product, not instrumentation. A merge with no
  // explanation is one an analyst cannot defend.
  CHECK(p.evidence.size() >= 3);

  f64 sum = 0;
  bool saw_geo = false, saw_time = false;
  for (const MatchEvidence& e : p.evidence) {
    sum += e.contribution;
    if (e.comparator == Comparator::GeoDistance) saw_geo = true;
    if (e.comparator == Comparator::TimeDelta) saw_time = true;
    CHECK(!e.a_value.empty());
  }
  CHECK(saw_geo);
  CHECK(saw_time);

  // The contributions must actually sum to the score, or the explanation is
  // decorative rather than the derivation.
  CHECK(sum == doctest::Approx(p.score).epsilon(1e-9));
}

TEST_CASE("contribution decays with distance rather than stepping") {
  auto score_at = [](f64 lat_offset) {
    std::vector<Record> records{
        rec(0, 0, 10.0, 20.0, 0, 4.0),
        rec(1, 1, 10.0 + lat_offset, 20.0, 0, 4.0),
    };
    const Resolution res = resolve(records, ErConfig{}, nullptr);
    return res.all_pairs.empty() ? -999.0 : res.all_pairs[0].score;
  };

  // A pair 5 km apart should outscore one 90 km apart. A hard threshold would
  // throw away exactly the information separating a confident merge from a
  // marginal one.
  CHECK(score_at(0.045) > score_at(0.8));
}

TEST_CASE("differential: union-find clustering matches a brute-force closure") {
  std::mt19937 rng(0x5EED);
  std::uniform_real_distribution<f64> lat_d(-60, 60);
  std::uniform_real_distribution<f64> lon_d(-170, 170);
  std::uniform_int_distribution<int> jitter(-40, 40);

  for (int trial = 0; trial < 8; ++trial) {
    std::vector<Record> records;
    u32 id = 0;

    // 60 real events, each reported by one or both agencies with realistic
    // disagreement — so there are genuine duplicates to find.
    for (int i = 0; i < 60; ++i) {
      const f64 lat = lat_d(rng);
      const f64 lon = lon_d(rng);
      const i32 t = 1000 + i * 500;
      const f64 mag = 2.0 + (i % 5);

      records.push_back(rec(id++, 0, lat, lon, t, mag));
      if (i % 3 != 0) {
        records.push_back(rec(id++, 1, lat + 0.05, lon + 0.05,
                              t + jitter(rng), mag + 0.1));
      }
    }

    const Resolution res = resolve(records, ErConfig{}, nullptr);

    std::vector<std::vector<u32>> got = res.members;
    for (auto& c : got) std::sort(c.begin(), c.end());
    std::sort(got.begin(), got.end());

    INFO("trial=", trial, " records=", records.size(),
         " accepted=", res.stats.pairs_accepted, " clusters=", res.stats.clusters);
    REQUIRE(got == brute_clusters(res, static_cast<u32>(records.size())));
  }
}

TEST_CASE("unmerge splits a cluster and is itself reversible in effect") {
  std::vector<Record> records{
      rec(0, 0, 10.00, 20.00, 0, 4.0),
      rec(1, 1, 10.01, 20.01, 2, 4.1),
  };
  Resolution res = resolve(records, ErConfig{}, nullptr);
  REQUIRE(res.cluster_of[0] == res.cluster_of[1]);
  REQUIRE(res.accepted.size() == 1);

  // Union-find cannot undo a union — this is its known weakness, and the
  // accepted edge list is what makes an un-merge possible at all.
  unmerge(res, 0);

  CHECK(res.cluster_of[0] != res.cluster_of[1]);
  CHECK(res.stats.clusters == 2);
  CHECK(res.accepted.empty());
}

TEST_CASE("oversized blocks are skipped AND counted") {
  // Everything at one point: the geo block becomes quadratic. Capping is
  // correct; capping silently is not, because under-merging looks exactly like
  // having nothing to merge.
  ErConfig cfg;
  cfg.max_block_size = 10;

  std::vector<Record> records;
  for (u32 i = 0; i < 50; ++i) {
    records.push_back(rec(i, static_cast<u16>(i % 2), 10.0, 20.0, 0, 4.0));
  }

  const Resolution res = resolve(records, cfg, nullptr);
  CHECK(res.stats.blocks_skipped > 0);
}

