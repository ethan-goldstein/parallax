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

// ── since ──────────────────────────────────────────────────────────────────
//
// `since` shipped as a no-op that passed everything: the plan carried the
// resolved bound and the executor tested `attr == geo_attr`, which is true for
// any entity that has geometry — so every entity "passed". EXPLAIN showed a
// Filter node saying `since` above a result that had not been filtered. These
// cases pin the behaviour that replaced it.

namespace {

/// Quakes at known valid-times, so a temporal predicate has something to cut.
struct TimedWorld {
  Store store;
  GeoIndex geo;
  SymbolId position, magnitude;
  u32 now_txn = 0;
  i64 now_unix = 1'785'000'000;

  /// entity index -> the magnitude it was asserted with.
  std::vector<f64> mag_of;

  TimedWorld() {
    position = store.symbols().intern("position");
    magnitude = store.symbols().intern("magnitude");

    store.begin_txn(now_unix);
    // Ten quakes, one per hour going back, magnitudes deliberately unordered
    // so arrival order and magnitude order disagree.
    const f64 mags[10] = {4.1, 6.8, 2.2, 5.5, 7.9, 3.0, 6.1, 4.7, 5.2, 3.8};
    for (u32 i = 0; i < 10; ++i) {
      const i64 t = now_unix - static_cast<i64>(i) * 3600 - 60;
      add(i, 10.0 + i, 20.0 + i, mags[i], from_unix(t));
    }
    store.commit_txn();
    store.rebuild_entity_index();
    geo.build();
    now_txn = store.current_txn().v;
  }

  void add(u32 entity, f64 lat, f64 lon, f64 mag, Timestamp valid_from) {
    const GeoPoint g = GeoPoint::from_degrees(lat, lon);
    const FactId f = store.assert_fact(EntityId{entity}, position, Value::geo(g),
                                       valid_from, kOpenValid, SourceId{0});
    geo.add(g, f.v);
    store.assert_fact(EntityId{entity}, magnitude, Value::real(mag), valid_from,
                      kOpenValid, SourceId{0});
    if (entity >= mag_of.size()) mag_of.resize(entity + 1, 0.0);
    mag_of[entity] = mag;
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

  std::vector<FactId> run(std::string_view sql, Plan* out_plan = nullptr) const {
    ParseResult pr = parse(sql);
    REQUIRE_FALSE(pr.error.failed);
    Plan p = plan_query(pr.query, ctx());
    std::vector<FactId> rows;
    execute(p, ctx(), pr.query, rows);
    if (out_plan) *out_plan = p;
    return rows;
  }

  /// The magnitudes behind an emitted row set, in emission order.
  std::vector<f64> mags(const std::vector<FactId>& rows) const {
    std::vector<f64> out;
    for (const FactId f : rows) out.push_back(mag_of[store.fact_entity(f).index()]);
    return out;
  }
};

}  // namespace

TEST_CASE("since actually filters on valid time") {
  const TimedWorld w;
  // Quakes sit one hour apart going back from `now`. A 4-hour window must not
  // return all ten — which is exactly what the no-op version did.
  const std::vector<FactId> rows = w.run("earthquakes since -4h");
  CHECK(rows.size() == 4);
  CHECK(w.run("earthquakes").size() == 10);
}

TEST_CASE("since with no window returns everything, and with a huge one too") {
  const TimedWorld w;
  CHECK(w.run("earthquakes since -100h").size() == 10);
  CHECK(w.run("earthquakes since -1h").size() == 1);
}

TEST_CASE("since keeps an entity whose revision lands inside the window") {
  TimedWorld w;
  // Entity 9 is ~9 hours old and outside a 2-hour window. Revise its magnitude
  // with a valid_from inside the window: the event is old, but something about
  // it became true recently, and dropping it would hide the revision this
  // engine exists to surface.
  w.store.begin_txn(w.now_unix);
  w.store.assert_fact(EntityId{9}, w.magnitude, Value::real(9.9),
                      from_unix(w.now_unix - 600), kOpenValid, SourceId{0});
  w.store.commit_txn();
  w.store.rebuild_entity_index();
  const_cast<TimedWorld&>(w).now_txn = w.store.current_txn().v;

  const std::vector<FactId> rows = w.run("earthquakes since -2h");
  bool found_nine = false;
  for (const FactId f : rows) {
    if (w.store.fact_entity(f).index() == 9) found_nine = true;
  }
  CHECK(found_nine);
}

// ── order by ───────────────────────────────────────────────────────────────
//
// `order by` built a Sort node and then never sorted. Because `limit` DOES
// execute, that made `limit 20` return an arbitrary twenty while the plan
// claimed an ordering — so these cases are about correctness, not presentation.

TEST_CASE("order by desc actually orders the emitted rows") {
  const TimedWorld w;
  const std::vector<f64> got = w.mags(w.run("earthquakes order by magnitude desc"));
  REQUIRE(got.size() == 10);
  for (size_t i = 1; i < got.size(); ++i) CHECK(got[i - 1] >= got[i]);
  CHECK(got.front() == doctest::Approx(7.9));
}

TEST_CASE("order by asc actually orders the emitted rows") {
  const TimedWorld w;
  const std::vector<f64> got = w.mags(w.run("earthquakes order by magnitude asc"));
  REQUIRE(got.size() == 10);
  for (size_t i = 1; i < got.size(); ++i) CHECK(got[i - 1] <= got[i]);
  CHECK(got.front() == doctest::Approx(2.2));
}

TEST_CASE("order by feeds limit — the top N are the real top N") {
  const TimedWorld w;
  const std::vector<f64> got =
      w.mags(w.run("earthquakes order by magnitude desc limit 3"));
  REQUIRE(got.size() == 3);
  // The three largest of {4.1,6.8,2.2,5.5,7.9,3.0,6.1,4.7,5.2,3.8}. Arrival
  // order would have given 4.1, 6.8, 2.2 — this is the bug in one assertion.
  CHECK(got[0] == doctest::Approx(7.9));
  CHECK(got[1] == doctest::Approx(6.8));
  CHECK(got[2] == doctest::Approx(6.1));
}

TEST_CASE("the Sort node reports what it actually sorted") {
  const TimedWorld w;
  Plan p;
  w.run("earthquakes order by magnitude desc", &p);
  bool saw_sort = false;
  for (const PlanNode& n : p.nodes) {
    if (n.op != PlanOp::Sort) continue;
    saw_sort = true;
    CHECK(n.actual_rows == 10);
    CHECK(n.detail == "magnitude desc");
  }
  CHECK(saw_sort);
}

TEST_CASE("an unknown order by field is a plan error, not a silent pass-through") {
  const TimedWorld w;
  ParseResult pr = parse("earthquakes order by nonexistent");
  REQUIRE_FALSE(pr.error.failed);
  const Plan p = plan_query(pr.query, w.ctx());
  // `where` can defensibly treat an unknown field as matching nothing. A Sort
  // node in EXPLAIN that ordered nothing cannot be defended the same way.
  CHECK_FALSE(p.ok());
  CHECK(p.error.find("order by") != std::string::npos);
}

TEST_CASE("entities missing the ordering attribute sort last in both directions") {
  TimedWorld w;
  // A quake with a position but no magnitude at all.
  w.store.begin_txn(w.now_unix);
  const GeoPoint g = GeoPoint::from_degrees(45.0, 45.0);
  const FactId f = w.store.assert_fact(EntityId{99}, w.position, Value::geo(g),
                                       from_unix(w.now_unix - 120), kOpenValid,
                                       SourceId{0});
  w.geo.add(g, f.v);
  w.store.commit_txn();
  w.store.rebuild_entity_index();
  w.geo.build();
  w.now_txn = w.store.current_txn().v;

  for (const char* sql :
       {"earthquakes order by magnitude asc", "earthquakes order by magnitude desc"}) {
    const std::vector<FactId> rows = w.run(sql);
    REQUIRE(rows.size() == 11);
    // Absent is not "smaller than everything" and not "larger than everything".
    // It is absent, and last is the only position that does not claim otherwise.
    CHECK(w.store.fact_entity(rows.back()).index() == 99);
  }
}

// ── forward relative time ───────────────────────────────────────────────────
//
// `+90m` exists because forecasts do. NOAA's aurora model asserts a probability
// for an instant ahead of the observation that produced it, so without a forward
// offset the only relative way to reach the region of the scrubber above the
// diagonal was not to have one.

TEST_CASE("a forward offset resolves ahead of now, a backward one behind") {
  const TimedWorld w;

  ParseResult fwd = parse("earthquakes as of +90m");
  REQUIRE_FALSE(fwd.error.failed);
  const Plan pf = plan_query(fwd.query, w.ctx());
  REQUIRE(pf.ok());

  ParseResult back = parse("earthquakes as of -90m");
  REQUIRE_FALSE(back.error.failed);
  const Plan pb = plan_query(back.query, w.ctx());
  REQUIRE(pb.ok());

  const Timestamp now = from_unix(w.now_unix);
  CHECK(pf.valid_at > now);
  CHECK(pb.valid_at < now);
  // Symmetric about now, to the second.
  CHECK((pf.valid_at - now) == (now - pb.valid_at));
}

TEST_CASE("a forward offset reaches facts that are not yet valid") {
  TimedWorld w;
  // A forecast: asserted now, valid for a window starting an hour ahead. This
  // is the shape NOAA's aurora feed has — observation time behind, forecast
  // time in front.
  w.store.begin_txn(w.now_unix);
  const GeoPoint g = GeoPoint::from_degrees(70.0, 25.0);
  const FactId f = w.store.assert_fact(EntityId{500}, w.position, Value::geo(g),
                                       from_unix(w.now_unix + 3600),
                                       from_unix(w.now_unix + 5400), SourceId{0});
  w.geo.add(g, f.v);
  w.store.assert_fact(EntityId{500}, w.magnitude, Value::real(1.0),
                      from_unix(w.now_unix + 3600), from_unix(w.now_unix + 5400),
                      SourceId{0});
  w.store.commit_txn();
  w.store.rebuild_entity_index();
  w.geo.build();
  w.now_txn = w.store.current_txn().v;

  const auto has500 = [&](const std::vector<FactId>& rows) {
    for (const FactId r : rows) {
      if (w.store.fact_entity(r).index() == 500) return true;
    }
    return false;
  };

  // Not true yet at now, true at +75m, closed again by +2h.
  CHECK_FALSE(has500(w.run("earthquakes")));
  CHECK(has500(w.run("earthquakes as of +75m")));
  CHECK_FALSE(has500(w.run("earthquakes as of +2h")));
}

TEST_CASE("a plus with no number is a parse error, not a silent zero") {
  const ParseResult pr = parse("earthquakes as of +");
  CHECK(pr.error.failed);
}

TEST_CASE("an absurd time offset is refused rather than cast out of range") {
  // `static_cast<i64>` of a double outside i64's range is undefined behaviour,
  // not a wrong answer, and the amount comes straight from user input. This was
  // reachable through the backward offset long before `+` existed; a targeted
  // fuzz run found it in seconds where 12M random parser executions had not.
  for (const char* sql : {
           "earthquakes as of +99999999999999999999h",
           "earthquakes as of -99999999999999999999h",
           "earthquakes since -1e30w",
       }) {
    const ParseResult pr = parse(sql);
    CHECK(pr.error.failed);
  }

  // The bound must not be so tight that real queries trip it.
  for (const char* sql : {"earthquakes as of +90m", "earthquakes as of -52w"}) {
    const ParseResult pr = parse(sql);
    CHECK_FALSE(pr.error.failed);
  }
}
