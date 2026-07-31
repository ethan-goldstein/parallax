// <string>/<string_view> reach here transitively through px/session.hpp, but
// naming them is the difference between compiling by luck and compiling by
// contract — and a transitive include is exactly what broke the Linux CI build
// last time while passing locally.
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

#include <doctest.h>

#include "px/session.hpp"

using namespace px;

namespace {

/// Writes wire::Fact records into the session's staging buffer exactly the way
/// TypeScript does — through raw bytes at the returned address — so this test
/// exercises the real ingest path rather than a friendlier C++ one.
u32 stage(Session& s, const std::vector<wire::Fact>& facts) {
  const u32 bytes = static_cast<u32>(facts.size() * sizeof(wire::Fact));
  std::memcpy(s.staging_buffer(bytes), facts.data(), bytes);
  return bytes;
}

wire::Fact geo_fact(u32 entity, u32 attr, f64 lat, f64 lon, i32 from, i32 to) {
  const Value v = Value::geo(GeoPoint::from_degrees(lat, lon));
  return wire::Fact{v.bits, entity, attr, from, to, 0, static_cast<u8>(v.kind), 0};
}

}  // namespace

TEST_CASE("ingest accepts well-formed facts and rejects malformed ones") {
  Session s;
  const SymbolId pos = s.intern("position");

  std::vector<wire::Fact> batch;
  batch.push_back(geo_fact(1, pos.v, 37.77, -122.42, 0, 100));
  batch.push_back(geo_fact(2, pos.v, 51.50, -0.12, 0, 100));

  // Empty valid interval — can never be visible, so it is a producer bug.
  batch.push_back(geo_fact(3, pos.v, 0.0, 0.0, 50, 50));

  // Kind tag outside the enum. Would index a switch out of range downstream.
  wire::Fact bad_kind = geo_fact(4, pos.v, 1.0, 1.0, 0, 10);
  bad_kind.vkind = 200;
  batch.push_back(bad_kind);

  const u32 bytes = stage(s, batch);
  const IngestResult r = s.ingest(0, bytes, 1000);

  CHECK(r.accepted == 2);
  CHECK(r.rejected == 2);
  CHECK(s.store().fact_count() == 2);
}

TEST_CASE("ingest rejects out-of-bounds ranges instead of reading past the buffer") {
  Session s;
  s.staging_buffer(64);

  // Offset and length both come from JavaScript and are therefore untrusted.
  // Under ASan a missing bounds check here is a heap-buffer-overflow; in the
  // browser it would be a silent read of unrelated heap with no error at all.
  CHECK(s.ingest(0, 1u << 30, 1000).accepted == 0);          // length past the end
  CHECK(s.ingest(1'000'000, 32, 1000).accepted == 0);        // offset past the end
  CHECK(s.ingest(4000, 4096, 1000).accepted == 0);           // offset ok, length overruns
  CHECK(s.ingest(0xFFFF'FFF0u, 32, 1000).accepted == 0);     // offset + len would wrap
  CHECK(s.store().fact_count() == 0);
}

TEST_CASE("staging buffer growth bumps the generation") {
  Session s;
  const u32 gen0 = s.generation();

  s.staging_buffer(64);
  const u32 gen1 = s.generation();
  CHECK(gen1 > gen0);  // first allocation moves from nothing to something

  // No growth needed — the generation must NOT change, or JS would rebuild its
  // views on every frame and the counter would be useless as a signal.
  s.staging_buffer(32);
  CHECK(s.generation() == gen1);

  s.staging_buffer(1'000'000);
  CHECK(s.generation() > gen1);
}

TEST_CASE("query_points packs only geo-valued facts") {
  Session s;
  const SymbolId pos = s.intern("position");
  const SymbolId mag = s.intern("magnitude");

  std::vector<wire::Fact> batch;
  batch.push_back(geo_fact(1, pos.v, 10.0, 20.0, 0, 100));

  // A non-geo fact on the same entity must not become a point.
  const Value m = Value::real(6.4);
  batch.push_back(wire::Fact{m.bits, 1, mag.v, 0, 100, 0, static_cast<u8>(m.kind), 0});

  s.ingest(0, stage(s, batch), 1000);

  const u32 now = s.store().current_txn().v;
  const Session::PointBatch ref = s.query_points(50, now, pos, mag);

  REQUIRE(ref.count == 1);
  CHECK(ref.truncated == 0);

  const wire::Point p = ref.data[0];
  CHECK(p.lat == doctest::Approx(10.0).epsilon(1e-5));
  CHECK(p.lon == doctest::Approx(20.0).epsilon(1e-5));

  // The scalar is resolved at the same (T, S) as the position, so a point can
  // never show one instant's magnitude at another instant's location.
  CHECK(p.scalar == doctest::Approx(6.4).epsilon(1e-5));
}

TEST_CASE("query_points truncates rather than reallocating the render buffer") {
  constexpr u32 kCap = 8;
  Session s(kCap);
  const SymbolId pos = s.intern("position");

  std::vector<wire::Fact> batch;
  for (u32 i = 0; i < kCap * 4; ++i) {
    batch.push_back(geo_fact(i, pos.v, static_cast<f64>(i % 80), 0.0, 0, 100));
  }

  s.ingest(0, stage(s, batch), 1000);

  const u32 gen_before = s.generation();
  const Session::PointBatch ref = s.query_points(50, s.store().current_txn().v, pos, SymbolId{});

  // Growing here would move memory that JavaScript holds a live view of. The
  // contract is: return what fits, say so, and never move.
  CHECK(ref.count == kCap);
  CHECK(ref.truncated == 1);
  CHECK(s.generation() == gen_before);
}

TEST_CASE("query_points reflects the system-time axis") {
  Session s;
  const SymbolId pos = s.intern("position");

  std::vector<wire::Fact> first{geo_fact(1, pos.v, 10.0, 20.0, 0, 100)};
  s.ingest(0, stage(s, first), 1000);
  const u32 txn1 = s.store().current_txn().v;

  std::vector<wire::Fact> second{geo_fact(2, pos.v, 30.0, 40.0, 0, 100)};
  s.ingest(0, stage(s, second), 2000);
  const u32 txn2 = s.store().current_txn().v;

  // Scrubbing the system axis back to txn1 must hide the second batch — this
  // is the interaction the whole project is built around, asserted at the
  // engine boundary rather than only through the UI.
  CHECK(s.query_points(50, txn1, pos, SymbolId{}).count == 1);
  CHECK(s.query_points(50, txn2, pos, SymbolId{}).count == 2);
}

// ── inspect ────────────────────────────────────────────────────────────────
//
// Picking runs through the Morton index, not the render buffer. That is not a
// preference: Session::query_points always returns points_.data(), one fixed
// allocation reused by every call, so after a multi-layer refresh it holds only
// the LAST layer's points. A caller that retained a handle per layer would read
// the wrong rows and never be told.

namespace {

wire::Fact f64_fact(u32 entity, u32 attr, f64 value, i32 from, i32 to) {
  const Value v = Value::real(value);
  return wire::Fact{v.bits, entity, attr, from, to, 0, static_cast<u8>(v.kind), 0};
}

wire::Fact sym_fact(u32 entity, u32 attr, SymbolId sym, i32 from, i32 to) {
  const Value v = Value::symbol(sym);
  return wire::Fact{v.bits, entity, attr, from, to, 0, static_cast<u8>(v.kind), 0};
}

/// Substring search — the JSON is asserted on by shape, not parsed, because a
/// parser in the test would be a second implementation to keep correct.
bool has(const std::string& hay, std::string_view needle) {
  return hay.find(needle) != std::string::npos;
}

}  // namespace

TEST_CASE("all_facts_for_entity returns versions that as_of_entity filters away") {
  Session s;
  const SymbolId pos = s.intern("position");
  const SymbolId mag = s.intern("magnitude");

  std::vector<wire::Fact> t1;
  t1.push_back(geo_fact(7, pos.v, 10.0, 20.0, 0, kOpenValid));
  t1.push_back(f64_fact(7, mag.v, 4.8, 0, kOpenValid));
  s.ingest(0, stage(s, t1), 1000);

  // Supersession is EXPLICIT in this store: assert_fact appends, and nothing is
  // implicitly displaced. A feed adapter correcting a value has to retract the
  // old row, and no adapter does that yet — see the note in digitraffic.ts.
  // Doing it by hand here is what a corrected feed will look like.
  // Row 0 is the position, row 1 the magnitude — assignment order.
  const FactId old_mag{1};
  s.store().begin_txn(2000);
  s.store().retract(old_mag);
  s.store().assert_fact(EntityId{7}, mag, Value::real(5.2), 0, kOpenValid, SourceId{0});
  s.store().commit_txn();
  s.finish_ingest();

  const u32 latest = s.store().current_txn().v;

  std::vector<FactId> now;
  s.store().as_of_entity(EntityId{7}, 50, TxnId{latest}, now);

  std::vector<FactId> all;
  s.store().all_facts_for_entity(EntityId{7}, all);

  // The filtered view can only show the survivor; history holds both beliefs.
  CHECK(now.size() == 2);  // position + the corrected magnitude
  CHECK(all.size() == 3);  // ... plus the retracted belief, still on the record
  CHECK(all.size() > now.size());

  // Ascending FactId, which is assignment order — a caller reading it as
  // history must not have to sort it.
  for (usize i = 1; i < all.size(); ++i) CHECK(all[i - 1].v < all[i].v);
}

TEST_CASE("inspect misses outside the radius and hits inside it") {
  Session s;
  const SymbolId pos = s.intern("position");

  std::vector<wire::Fact> b;
  b.push_back(geo_fact(1, pos.v, 60.0, 25.0, 0, kOpenValid));
  s.ingest(0, stage(s, b), 1000);
  s.finish_ingest();

  const u32 sys = s.store().current_txn().v;

  // ~1.1 km away: outside a 500 m radius, inside a 5 km one.
  const std::string miss = s.inspect_json(60.01, 25.0, 500.0, 50, sys, "");
  CHECK(has(miss, "\"hit\":false"));

  const std::string hit = s.inspect_json(60.01, 25.0, 5000.0, 50, sys, "");
  CHECK(has(hit, "\"hit\":true"));
  CHECK(has(hit, "\"entity\":1"));
}

TEST_CASE("inspect picks the nearer of two candidates") {
  Session s;
  const SymbolId pos = s.intern("position");

  std::vector<wire::Fact> b;
  b.push_back(geo_fact(1, pos.v, 60.000, 25.0, 0, kOpenValid));
  b.push_back(geo_fact(2, pos.v, 60.050, 25.0, 0, kOpenValid));
  s.ingest(0, stage(s, b), 1000);
  s.finish_ingest();

  const u32 sys = s.store().current_txn().v;

  CHECK(has(s.inspect_json(60.001, 25.0, 50'000.0, 50, sys, ""), "\"entity\":1"));
  CHECK(has(s.inspect_json(60.049, 25.0, 50'000.0, 50, sys, ""), "\"entity\":2"));
}

TEST_CASE("inspect honours the caller's displayed-attribute list") {
  Session s;
  const SymbolId quake = s.intern("position");
  const SymbolId vessel = s.intern("vessel_position");

  std::vector<wire::Fact> b;
  b.push_back(geo_fact(1, quake.v, 60.0, 25.0, 0, kOpenValid));
  b.push_back(geo_fact(2, vessel.v, 60.001, 25.0, 0, kOpenValid));
  s.ingest(0, stage(s, b), 1000);
  s.finish_ingest();

  const u32 sys = s.store().current_txn().v;

  // The vessel is nearer, but a caller showing only the seismic layer must not
  // be told about it — visibility is a property of the view, and this is how
  // the view states it.
  const std::string only_quakes =
      s.inspect_json(60.0009, 25.0, 50'000.0, 50, sys, std::to_string(quake.v));
  CHECK(has(only_quakes, "\"entity\":1"));

  const std::string both = s.inspect_json(
      60.0009, 25.0, 50'000.0, 50, sys, std::to_string(quake.v) + "," + std::to_string(vessel.v));
  CHECK(has(both, "\"entity\":2"));

  // Empty means "any geometry", not "no geometry".
  CHECK(has(s.inspect_json(60.0009, 25.0, 50'000.0, 50, sys, ""), "\"hit\":true"));
}

TEST_CASE("inspect surfaces every version, and resolves symbols to text") {
  Session s;
  const SymbolId pos = s.intern("position");
  const SymbolId mag = s.intern("magnitude");
  const SymbolId label = s.intern("label");
  const SymbolId place = s.intern("46 km E of Petropavlovsk");

  std::vector<wire::Fact> t1;
  t1.push_back(geo_fact(3, pos.v, 53.0, 158.0, 0, kOpenValid));
  t1.push_back(f64_fact(3, mag.v, 4.8, 0, kOpenValid));
  t1.push_back(sym_fact(3, label.v, place, 0, kOpenValid));
  s.ingest(0, stage(s, t1), 1000);

  // A correction, the way a feed adapter will have to issue one.
  s.store().begin_txn(2000);
  s.store().retract(FactId{1});
  s.store().assert_fact(EntityId{3}, mag, Value::real(5.2), 0, kOpenValid, SourceId{0});
  s.store().commit_txn();
  s.finish_ingest();

  const u32 sys = s.store().current_txn().v;
  const std::string j = s.inspect_json(53.0, 158.0, 5000.0, 50, sys, "");

  CHECK(has(j, "\"hit\":true"));
  // A Sym value must come back as its text, not as a bare symbol id — the
  // symbol table deliberately does not cross the boundary.
  CHECK(has(j, "46 km E of Petropavlovsk"));
  CHECK(has(j, "\"attr\":\"position\""));
  // Both magnitudes appear in history; only the survivor in attributes.
  CHECK(has(j, "4.8"));
  CHECK(has(j, "5.2"));
  CHECK(has(j, "\"history\":["));
  CHECK(has(j, "\"attributes\":["));
}

// ── query-time overrides ───────────────────────────────────────────────────
//
// The UI's scrubber owns both time axes; the query text says only WHAT to
// select. These two cases pin the reasons that has to be a parameter rather
// than string surgery on the SQL.

TEST_CASE("run_query overrides pin the system axis by transaction index") {
  Session s;
  const SymbolId pos = s.intern("position");
  s.register_source("things", pos, SymbolId{});

  std::vector<wire::Fact> first{geo_fact(1, pos.v, 10.0, 20.0, 0, kOpenValid)};
  s.ingest(0, stage(s, first), 1000);
  const u32 txn1 = s.store().current_txn().v;

  // Deliberately the SAME wall clock as txn1. This is the case that makes the
  // override necessary rather than merely convenient: an `as of ... @ <clock>`
  // clause would round-trip through txn_at_or_before and land on txn2, because
  // that is the last transaction at or before that second. In the real app the
  // live feeds all bucket into the current minute, so this tie is the common
  // case at exactly the end of the axis the scrubber opens on.
  std::vector<wire::Fact> second{geo_fact(2, pos.v, 30.0, 40.0, 0, kOpenValid)};
  s.ingest(0, stage(s, second), 1000);
  const u32 txn2 = s.store().current_txn().v;
  s.finish_ingest();

  REQUIRE(txn1 != txn2);

  QueryOptions at_first;
  at_first.has_time_override = true;
  at_first.valid_at = 50;
  at_first.sys_at = txn1;
  CHECK(s.run_query("things", 0, at_first).batch.count == 1);

  QueryOptions at_second = at_first;
  at_second.sys_at = txn2;
  CHECK(s.run_query("things", 0, at_second).batch.count == 2);

  // The override must also beat an explicit `as of` in the SQL — otherwise the
  // scrubber and the query text would each believe they were authoritative.
  CHECK(s.run_query("things as of \"2038-01-01T00:00:00\"", 0, at_first).batch.count == 1);
}

TEST_CASE("a silent re-run executes but is not recorded") {
  Session s;
  const SymbolId pos = s.intern("position");
  s.register_source("things", pos, SymbolId{});

  std::vector<wire::Fact> facts{geo_fact(1, pos.v, 10.0, 20.0, 0, kOpenValid)};
  s.ingest(0, stage(s, facts), 1000);
  s.finish_ingest();

  QueryOptions silent;
  silent.has_time_override = true;
  silent.valid_at = 50;
  silent.sys_at = s.store().current_txn().v;
  silent.record = false;

  // Sixty of these is one scrubber drag. The result is real every time; only
  // the audit write is suppressed.
  for (int i = 0; i < 60; ++i) {
    CHECK(s.run_query("things", 0, silent).batch.count == 1);
  }
  CHECK(!has(s.audit_json(50), "\"query\""));

  // The same query, asked rather than scrubbed, is recorded.
  QueryOptions recorded = silent;
  recorded.record = true;
  s.run_query("things", 0, recorded);
  CHECK(has(s.audit_json(50), "things"));
}
