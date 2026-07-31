// ── px_bench ────────────────────────────────────────────────────────────────
// The benchmark harness. Emits a markdown table CI commits.
//
// ── methodology, because a number without one is a claim ───────────────────
//
// * MINIMUM of N runs, not the mean. The minimum is the closest observation to
//   the machine's actual capability: noise only ever adds time, so the mean
//   measures the noise as much as the code. Reporting a mean makes a build
//   look slower on a busy CI runner and invites tuning against scheduler jitter.
// * Warmup runs are discarded, so the first-touch page faults and cold caches
//   are not counted as the algorithm's cost.
// * Every result is checksummed and the checksum printed. A compiler that
//   proved the work unused would delete it, and the benchmark would then report
//   the speed of an empty loop.
// * The dataset is generated from a FIXED seed, so two runs measure the same
//   work and a regression is a regression rather than different data.
//
// Deliberately no -march=native (see CMakePresets): it makes local numbers
// incomparable to CI numbers, and a benchmark nobody else can reproduce is a
// claim rather than a measurement.
// ────────────────────────────────────────────────────────────────────────────
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <random>
#include <string>
#include <vector>

#include "px/bench.hpp"
#include "px/er.hpp"
#include "px/geo.hpp"
#include "px/graph.hpp"
#include "px/ql/parser.hpp"
#include "px/store.hpp"

using namespace px;

namespace {

struct Result {
  std::string name;
  std::string unit;
  f64 value = 0;
  f64 best_ms = 0;
  u64 checksum = 0;
  std::string note;
};

std::vector<Result> g_results;

/// Runs `fn` warmup+iters times, keeps the minimum, and records throughput.
template <class Fn>
void bench(const char* name, u64 work_items, const char* unit, Fn&& fn, int iters = 7,
           int warmup = 2, const char* note = "") {
  u64 checksum = 0;
  for (int i = 0; i < warmup; ++i) checksum ^= fn();

  f64 best = 1e30;
  for (int i = 0; i < iters; ++i) {
    const f64 t0 = now_ms();
    checksum ^= fn();
    best = std::min(best, now_ms() - t0);
  }

  Result r;
  r.name = name;
  r.unit = unit;
  r.best_ms = best;
  r.checksum = checksum;
  r.note = note;
  r.value = best > 0 ? static_cast<f64>(work_items) / (best / 1000.0) : 0;
  g_results.push_back(std::move(r));
}

std::string commas(f64 v) {
  char buf[64];
  std::snprintf(buf, sizeof(buf), "%.0f", v);
  std::string s(buf);
  for (int i = static_cast<int>(s.size()) - 3; i > 0; i -= 3) {
    s.insert(static_cast<usize>(i), ",");
  }
  return s;
}

/// A store shaped like the real feeds.
///
/// Crucially, valid intervals are OPEN-ENDED — [origin, forever) — because that
/// is what the actual data looks like: an earthquake, once it has happened,
/// stays true. The first version used short marching intervals, which meant
/// the "full scan" benchmark was silently pruning 58 of 62 chunks and
/// measuring the zone maps rather than the kernel. Benchmark data that does
/// not match production data measures the wrong thing.
Store make_store(u32 facts) {
  Store s;
  s.reserve(facts);
  const SymbolId pos = s.symbols().intern("position");
  const SymbolId mag = s.symbols().intern("magnitude");

  std::mt19937 rng(0xB00B5);
  std::uniform_real_distribution<f64> lat_d(-80, 80);
  std::uniform_real_distribution<f64> lon_d(-179, 179);

  // 64 facts per transaction, matching the batch shape the feeds produce.
  u32 written = 0;
  u32 entity = 0;
  while (written < facts) {
    s.begin_txn(1'785'000'000 + written);
    for (u32 k = 0; k < 64 && written < facts; ++k, ++written) {
      const auto from = static_cast<Timestamp>(written / 4);
      s.assert_fact(EntityId{entity}, pos,
                    Value::geo(GeoPoint::from_degrees(lat_d(rng), lon_d(rng))), from,
                    kOpenValid, SourceId{0});
      ++written;
      if (written < facts) {
        s.assert_fact(EntityId{entity}, mag, Value::real(2.0 + (entity % 6)), from,
                      kOpenValid, SourceId{0});
      }
      ++entity;
    }
    s.commit_txn();
  }
  s.rebuild_entity_index();
  return s;
}

}  // namespace

int main(int argc, char** argv) {
  u32 facts = 2'000'000;
  bool markdown = false;
  for (int i = 1; i < argc; ++i) {
    if (std::strcmp(argv[i], "--markdown") == 0) markdown = true;
    else if (std::strcmp(argv[i], "--facts") == 0 && i + 1 < argc) {
      facts = static_cast<u32>(std::atoi(argv[++i]));
    }
  }

  std::fprintf(stderr, "building %s facts...\n", commas(facts).c_str());
  Store store = make_store(facts);
  const u32 now_txn = store.current_txn().v;

  // ── bitemporal scan ──────────────────────────────────────────────────────
  //
  // Throughput is measured against rows ACTUALLY SCANNED, not against the size
  // of the store. Dividing by total facts when the zone maps pruned 90% of
  // them reports the pruning as scan speed — the first version of this printed
  // 10.8 BILLION facts/s and 4 trillion, which is how I noticed. An impossible
  // number is a bug in the benchmark, not a result.
  std::vector<FactId> out;
  out.reserve(facts);

  // A valid instant every fact is live at, so nothing is prunable and the
  // kernel is measured doing real work on every row.
  // Every fact is live at the latest origin time, so nothing is prunable.
  const auto full_scan_at = static_cast<Timestamp>(facts / 4 + 1);
  u64 scanned_rows = 0;
  {
    ScanStats probe{};
    out.clear();
    store.as_of(full_scan_at, TxnId{now_txn}, out, &probe);
    scanned_rows = probe.rows_scanned;
    std::fprintf(stderr, "full-scan probe: %s rows scanned, %u/%u chunks skipped\n",
                 commas(static_cast<f64>(scanned_rows)).c_str(), probe.chunks_skipped,
                 probe.chunks_total);
  }

  bench("bitemporal scan (scalar)", scanned_rows, "rows/s", [&] {
    out.clear();
    ScanStats st{};
    store.as_of_with(Store::Kernel::Scalar, full_scan_at, TxnId{now_txn}, out, &st);
    return static_cast<u64>(out.size()) ^ static_cast<u64>(st.rows_scanned);
  }, 7, 2, "no chunk prunable at this instant");

  if (Store::simd_available()) {
    bench("bitemporal scan (SIMD)", scanned_rows, "rows/s", [&] {
      out.clear();
      ScanStats st{};
      store.as_of_with(Store::Kernel::Simd, full_scan_at, TxnId{now_txn}, out, &st);
      return static_cast<u64>(out.size()) ^ static_cast<u64>(st.rows_scanned);
    }, 7, 2, "same rows, vectorised");
  }

  // Zone-map pruning, reported as a SKIP RATE rather than a throughput.
  // Expressing "we did not do the work" as facts-per-second is meaningless;
  // the honest measure is how much was skipped and how long the skip took.
  {
    ScanStats st{};
    out.clear();
    store.as_of(kTimeMin + 1, TxnId{now_txn}, out, &st);
    const f64 skip_pct =
        st.chunks_total > 0 ? 100.0 * st.chunks_skipped / st.chunks_total : 0.0;
    char note[128];
    std::snprintf(note, sizeof(note), "%u/%u chunks skipped (%.0f%%), %s rows read",
                  st.chunks_skipped, st.chunks_total, skip_pct,
                  commas(static_cast<f64>(st.rows_scanned)).c_str());
    bench("zone-map prune (query before all data)", 1, "queries/s", [&] {
      out.clear();
      ScanStats s2{};
      store.as_of(kTimeMin + 1, TxnId{now_txn}, out, &s2);
      return static_cast<u64>(s2.chunks_skipped);
    }, 200, 20, note);
  }

  // ── spatial index ────────────────────────────────────────────────────────
  GeoIndex geo;
  geo.reserve(store.fact_count());
  for (u32 i = 0; i < static_cast<u32>(store.fact_count()); ++i) {
    const Value v = store.fact_value(FactId{i});
    if (v.kind == Kind::Geo) geo.add(v.as_geo(), i);
  }

  // Rebuild from an UNSORTED index each iteration.
  //
  // Calling build() repeatedly on the same object measures re-sorting data that
  // is already sorted, which std::sort does far faster than the real thing —
  // the first version reported 958M points/s, roughly 5x the honest figure.
  // A benchmark whose second iteration does less work than its first is
  // measuring the wrong thing.
  std::vector<GeoPoint> geo_src;
  geo_src.reserve(store.fact_count());
  for (u32 i = 0; i < static_cast<u32>(store.fact_count()); ++i) {
    const Value v = store.fact_value(FactId{i});
    if (v.kind == Kind::Geo) geo_src.push_back(v.as_geo());
  }

  bench("geo index build (add + sort)", static_cast<u64>(geo_src.size()), "points/s", [&] {
    GeoIndex fresh;
    fresh.reserve(geo_src.size());
    for (u32 i = 0; i < static_cast<u32>(geo_src.size()); ++i) fresh.add(geo_src[i], i);
    fresh.build();
    return static_cast<u64>(fresh.size());
  }, 5, 1, "fresh index each iteration");

  geo.build();
  std::vector<u32> hits;
  bench("geo bbox query (10 deg box)", 1, "queries/s", [&] {
    hits.clear();
    geo.query_bbox(BBox{10, 10, 20, 20}, hits);
    return static_cast<u64>(hits.size());
  }, 200, 20);

  bench("geo k-NN (k=10)", 1, "queries/s", [&] {
    hits.clear();
    geo.query_knn(15.0, 15.0, 10, hits);
    return static_cast<u64>(hits.size());
  }, 100, 10);

  // ── graph ────────────────────────────────────────────────────────────────
  {
    const u32 nodes = 200'000;
    std::vector<Edge> edges;
    edges.reserve(nodes * 4);
    std::mt19937 rng(0xCAFE);
    std::uniform_int_distribution<u32> pick(0, nodes - 1);
    for (u32 i = 0; i < nodes * 4; ++i) edges.push_back(Edge{pick(rng), pick(rng)});

    bench("CSR build (counting sort)", static_cast<u64>(edges.size()), "edges/s", [&] {
      Csr fresh;
      fresh.build(edges, nodes);
      return static_cast<u64>(fresh.edge_count());
    }, 5, 1, "fresh CSR each iteration");

    Csr g;

    g.build(edges, nodes);
    std::vector<u32> reached;
    bench("k-hop BFS (k=3)", 1, "traversals/s", [&] {
      reached.clear();
      g.k_hop(0, 3, reached);
      return static_cast<u64>(reached.size());
    }, 50, 5);

    std::vector<u32> labels;
    bench("label propagation (10 iters)", nodes, "nodes/s", [&] {
      g.label_propagation(10, labels);
      return static_cast<u64>(labels.size());
    }, 3, 1);
  }

  // ── entity resolution ────────────────────────────────────────────────────
  {
    std::vector<er::Record> records;
    std::mt19937 rng(0xF00D);
    std::uniform_real_distribution<f64> lat_d(-70, 70);
    std::uniform_real_distribution<f64> lon_d(-179, 179);

    for (u32 i = 0; i < 20'000; ++i) {
      const f64 lat = lat_d(rng), lon = lon_d(rng);
      const auto t = static_cast<Timestamp>(1000 + i * 30);
      er::Record a;
      a.id = static_cast<u32>(records.size());
      a.source = 0;
      a.position = GeoPoint::from_degrees(lat, lon);
      a.time = t;
      a.magnitude = 3.0;
      a.has_magnitude = true;
      records.push_back(a);

      if (i % 2 == 0) {
        er::Record b = a;
        b.id = static_cast<u32>(records.size());
        b.source = 1;
        b.position = GeoPoint::from_degrees(lat + 0.05, lon + 0.05);
        b.time = t + 3;
        records.push_back(b);
      }
    }

    bench("entity resolution (block+score+cluster)", static_cast<u64>(records.size()), "records/s", [&] {
      const er::Resolution r = er::resolve(records, er::ErConfig{}, nullptr);
      return static_cast<u64>(r.stats.pairs_accepted) ^
             static_cast<u64>(r.stats.pairs_compared);
    }, 5, 1);
  }

  // ── query parsing ────────────────────────────────────────────────────────
  bench("query parse", 1, "parses/s", [&] {
    const ql::ParseResult r =
        ql::parse("vessels within 50km of (60.1, 24.9) since -6h limit 100");
    return static_cast<u64>(r.query.nodes.size());
  }, 2000, 200);

  // ── report ───────────────────────────────────────────────────────────────
  if (markdown) {
    std::printf("| benchmark | throughput | best of N | note |\n");
    std::printf("| --- | ---: | ---: | --- |\n");
    for (const Result& r : g_results) {
      std::printf("| %s | %s %s | %.3f ms | %s |\n", r.name.c_str(),
                  commas(r.value).c_str(), r.unit.c_str(), r.best_ms, r.note.c_str());
    }
    std::printf("\n");
    std::printf("Facts: %s. Minimum of N runs after warmup; results checksummed so the\n",
                commas(static_cast<f64>(store.fact_count())).c_str());
    std::printf("optimiser cannot elide the work. SIMD available: %s.\n",
                Store::simd_available() ? "yes" : "no (native build)");
  } else {
    std::printf("%-42s %18s %12s\n", "benchmark", "throughput", "best");
    for (const Result& r : g_results) {
      std::printf("%-42s %12s %-5s %9.3f ms\n", r.name.c_str(), commas(r.value).c_str(),
                  r.unit.c_str(), r.best_ms);
    }
    // Printing the checksum keeps the results observably used — belt and
    // braces alongside the XOR accumulation inside bench().
    u64 all = 0;
    for (const Result& r : g_results) all ^= r.checksum;
    std::printf("\nchecksum %llu (printed so the work cannot be optimised away)\n",
                static_cast<unsigned long long>(all));
  }

  return 0;
}
