#include <cstring>
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
