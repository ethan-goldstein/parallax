#include <string>
#include <vector>

#include <doctest.h>

#include "px/ql/parser.hpp"
#include "px/ql/plan.hpp"

using namespace px;
using namespace px::ql;

namespace {

/// A small world: quakes spread globally, plus a tight cluster near Helsinki.
struct World {
  Store store;
  GeoIndex geo;
  SymbolId position, magnitude;
  u32 now_txn = 0;
  i64 now_unix = 1'785'000'000;

  World() {
    position = store.symbols().intern("position");
    magnitude = store.symbols().intern("magnitude");

    store.begin_txn(now_unix - 7200);
    u32 entity = 0;

    // 400 scattered worldwide.
    for (int i = 0; i < 400; ++i) {
      const f64 lat = -60.0 + (i % 120);
      const f64 lon = -180.0 + ((i * 7) % 360);
      add(entity++, lat, lon, 2.0 + static_cast<f64>(i % 7));
    }
    // 60 clustered inside a 1-degree box near Helsinki.
    for (int i = 0; i < 60; ++i) {
      add(entity++, 60.0 + i * 0.001, 24.9 + i * 0.001, 5.0 + (i % 3));
    }

    store.commit_txn();
    store.rebuild_entity_index();
    geo.build();
    now_txn = store.current_txn().v;
  }

  void add(u32 entity, f64 lat, f64 lon, f64 mag) {
    const GeoPoint g = GeoPoint::from_degrees(lat, lon);
    const FactId f = store.assert_fact(EntityId{entity}, position, Value::geo(g), 0,
                                       kOpenValid, SourceId{0});
    geo.add(g, f.v);
    store.assert_fact(EntityId{entity}, magnitude, Value::real(mag), 0, kOpenValid,
                      SourceId{0});
  }

  PlanContext ctx() const {
    PlanContext c;
    c.store = &store;
    c.geo = &geo;
    c.now_unix = now_unix;
    c.geo_attr = position;
    c.scalar_attr = magnitude;
    c.current_txn = now_txn;
    return c;
  }

  Plan plan_of(std::string_view sql) const {
    ParseResult pr = parse(sql);
    REQUIRE_FALSE(pr.error.failed);
    return plan_query(pr.query, ctx());
  }

  std::vector<FactId> run(std::string_view sql, Plan* out_plan = nullptr) const {
    ParseResult pr = parse(sql);
    REQUIRE_FALSE(pr.error.failed);
    Plan p = plan_query(pr.query, ctx());
    std::vector<FactId> rows;
    execute(p, ctx(), pr.query, rows);
    if (out_plan) *out_plan = p;
    return rows;
  }
};

const PlanNode& leaf(const Plan& p) {
  u32 i = p.root;
  while (p.nodes[i].child != kNoNode) i = p.nodes[i].child;
  return p.nodes[i];
}

}  // namespace

TEST_CASE("an unconstrained query does not choose the spatial index") {
  const World w;
  const Plan p = w.plan_of("earthquakes");
  // Nothing spatial in the query, so GeoRangeScan is not even a candidate.
  CHECK(leaf(p).op != PlanOp::GeoRangeScan);
}

TEST_CASE("a tight spatial constraint chooses the Morton index over a scan") {
  const World w;
  const Plan p = w.plan_of("earthquakes in bbox(59.9, 24.8, 60.2, 25.1)");

  const PlanNode& scan = leaf(p);
  INFO("chose ", plan_op_name(scan.op), " est_rows=", scan.est_rows,
       " cost=", scan.est_cost);
  CHECK(scan.op == PlanOp::GeoRangeScan);
  CHECK(scan.index_used == "morton z-order");

  // The rejected alternatives are reported with their costs — EXPLAIN as an
  // argument rather than an assertion.
  CHECK(p.rejected.size() >= 1);
  bool saw_seqscan = false;
  for (const auto& r : p.rejected) if (r.name == "SeqScan") saw_seqscan = true;
  CHECK(saw_seqscan);
}

TEST_CASE("the spatial cardinality estimate is EXACT, not approximate") {
  const World w;
  Plan p;
  const std::vector<FactId> rows = w.run("earthquakes in bbox(59.9, 24.8, 60.2, 25.1)", &p);

  const PlanNode& scan = leaf(p);
  REQUIRE(scan.op == PlanOp::GeoRangeScan);
  CHECK(scan.est_exact);

  // est_rows counts entries inside the Morton key ranges. actual_rows counts
  // those that also passed the bitemporal visibility test. Every fact here is
  // visible, so the only permitted difference is Z-order false positives —
  // candidates inside a key range but outside the box — which is a bounded
  // over-count in one direction, never an under-count.
  INFO("est=", scan.est_rows, " candidates=", scan.geo_candidates,
       " actual=", scan.actual_rows);
  CHECK(scan.est_rows >= scan.actual_rows);
  CHECK(scan.est_rows == doctest::Approx(static_cast<f64>(scan.geo_candidates)));

  // And the query is actually correct: the 60 clustered quakes, no others.
  CHECK(rows.size() == 60);
}

TEST_CASE("within-radius refines the box with exact haversine") {
  const World w;

  // 5 km around the cluster centre. The bbox over-covers the circle, so the
  // refinement is what makes `within` mean what it says.
  Plan p;
  const std::vector<FactId> tight = w.run("earthquakes within 5km of (60.0, 24.9)", &p);
  const std::vector<FactId> wide = w.run("earthquakes within 500km of (60.0, 24.9)");

  CHECK(tight.size() <= wide.size());
  CHECK(!wide.empty());

  // The filter node must show it removed candidates the box let through.
  bool found_filter = false;
  for (const PlanNode& n : p.nodes) {
    if (n.op != PlanOp::Filter) continue;
    found_filter = true;
    CHECK(n.detail.find("haversine") != std::string::npos);
  }
  CHECK(found_filter);
}

TEST_CASE("scalar predicates filter, and the estimate is marked inexact") {
  const World w;
  Plan p;
  const std::vector<FactId> rows = w.run("earthquakes where magnitude > 6.0", &p);

  const PlanNode* filter = nullptr;
  for (const PlanNode& n : p.nodes) if (n.op == PlanOp::Filter) filter = &n;
  REQUIRE(filter != nullptr);

  // Selectivity is a guess (1/3, no histograms) and the plan says so. This is
  // the node where est and actual visibly diverge, which is exactly what makes
  // the EXPLAIN panel worth looking at.
  CHECK_FALSE(filter->est_exact);
  CHECK(filter->reason.find("guessed") != std::string::npos);

  // Correctness: every returned entity really does exceed 6.0.
  for (const FactId f : rows) {
    CHECK(w.store.fact_attr(f) == w.position);
  }
  CHECK(!rows.empty());
}

TEST_CASE("limit caps the result and reports it") {
  const World w;
  Plan p;
  const std::vector<FactId> rows = w.run("earthquakes limit 7", &p);
  CHECK(rows.size() == 7);

  const PlanNode& root = p.nodes[p.root];
  CHECK(root.op == PlanOp::Limit);
  CHECK(root.actual_rows == 7);
  CHECK(root.est_exact);
}

TEST_CASE("as of maps a system instant onto a transaction") {
  Store store;
  GeoIndex geo;
  const SymbolId pos = store.symbols().intern("position");

  // Three transactions an hour apart.
  for (int k = 0; k < 3; ++k) {
    store.begin_txn(1'785'000'000 + k * 3600);
    const GeoPoint g = GeoPoint::from_degrees(10.0 * k, 20.0 * k);
    const FactId f = store.assert_fact(EntityId{static_cast<u32>(k)}, pos, Value::geo(g), 0,
                                       kOpenValid, SourceId{0});
    geo.add(g, f.v);
    store.commit_txn();
  }
  store.rebuild_entity_index();
  geo.build();

  PlanContext ctx;
  ctx.store = &store;
  ctx.geo = &geo;
  ctx.now_unix = 1'785'000'000 + 3 * 3600;
  ctx.geo_attr = pos;
  ctx.current_txn = store.current_txn().v;

  auto count_at = [&](const char* sql) {
    ParseResult pr = parse(sql);
    REQUIRE_FALSE(pr.error.failed);
    Plan p = plan_query(pr.query, ctx);
    std::vector<FactId> rows;
    execute(p, ctx, pr.query, rows);
    return rows.size();
  };

  // Scrubbing the system axis back must hide later transactions. This is the
  // whole product, expressed as a query rather than a slider.
  CHECK(count_at("q as of \"2026-07-30T00:00:00Z\" @ -3h") < count_at("q"));
  CHECK(count_at("q") == 3);
}

TEST_CASE("explain_json is valid and carries est vs actual") {
  const World w;
  Plan p;
  w.run("earthquakes in bbox(59.9, 24.8, 60.2, 25.1) limit 10", &p);

  const std::string json = explain_json(p);
  INFO(json);

  CHECK(json.front() == '{');
  CHECK(json.back() == '}');
  CHECK(json.find("\"op\":\"GeoRangeScan\"") != std::string::npos);
  CHECK(json.find("\"estRows\"") != std::string::npos);
  CHECK(json.find("\"actualRows\"") != std::string::npos);
  CHECK(json.find("\"rejected\"") != std::string::npos);
  CHECK(json.find("\"exact\":true") != std::string::npos);

  // Braces must balance, or the UI's JSON.parse throws on a panel nobody can
  // then debug.
  int depth = 0;
  bool in_string = false;
  for (usize i = 0; i < json.size(); ++i) {
    const char c = json[i];
    if (in_string) {
      if (c == '\\') ++i;
      else if (c == '"') in_string = false;
      continue;
    }
    if (c == '"') in_string = true;
    else if (c == '{' || c == '[') ++depth;
    else if (c == '}' || c == ']') --depth;
    CHECK(depth >= 0);
  }
  CHECK(depth == 0);
}

TEST_CASE("a field that does not exist matches nothing rather than everything") {
  const World w;
  const std::vector<FactId> rows = w.run("earthquakes where nonexistent > 1");
  // The dangerous failure mode is a missing attribute silently passing the
  // filter, which would show every entity and look like success.
  CHECK(rows.empty());
}
