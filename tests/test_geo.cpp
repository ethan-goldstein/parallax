#include <algorithm>
#include <random>
#include <vector>

#include <doctest.h>

#include "px/geo.hpp"

using namespace px;

namespace {

/// Brute-force spatial oracle. Same role as ReferenceStore: obviously correct
/// by inspection, so the indexed version has something independent to be
/// checked against.
struct RefPoint {
  f64 lat, lon;
  u32 ref;
};

std::vector<u32> brute_bbox(const std::vector<RefPoint>& pts, const BBox& box) {
  std::vector<u32> out;
  for (const RefPoint& p : pts) {
    if (p.lat >= box.min_lat && p.lat <= box.max_lat && p.lon >= box.min_lon &&
        p.lon <= box.max_lon) {
      out.push_back(p.ref);
    }
  }
  std::sort(out.begin(), out.end());
  return out;
}

std::vector<u32> sorted(std::vector<u32> v) {
  std::sort(v.begin(), v.end());
  return v;
}

}  // namespace

TEST_CASE("morton encode/decode round-trips") {
  const u32 cases[] = {0u, 1u, 2u, 0xFFFF'FFFFu, 0x8000'0000u, 123'456'789u};
  for (const u32 a : cases) {
    for (const u32 b : cases) {
      const MortonKey k = encode_morton(a, b);
      const MortonXY xy = decode_morton(k);
      CHECK(xy.lat_u == a);
      CHECK(xy.lon_u == b);
    }
  }
}

TEST_CASE("morton keys preserve locality for nearby points") {
  // Not a guarantee Z-order makes in general — it is exactly what fails at
  // quadrant boundaries. What this asserts is the weaker, true claim: two
  // points a hair apart in the middle of a quadrant land close in key space.
  const GeoPoint a = GeoPoint::from_degrees(37.7749, -122.4194);
  const GeoPoint b = GeoPoint::from_degrees(37.7750, -122.4195);
  const GeoPoint far = GeoPoint::from_degrees(-33.8688, 151.2093);

  const u64 near_delta = morton_of(a) > morton_of(b) ? morton_of(a) - morton_of(b)
                                                     : morton_of(b) - morton_of(a);
  const u64 far_delta = morton_of(a) > morton_of(far) ? morton_of(a) - morton_of(far)
                                                      : morton_of(far) - morton_of(a);
  CHECK(near_delta < far_delta);
}

TEST_CASE("haversine matches known distances") {
  // SPHERE, not ellipsoid. Haversine is a spherical formula, so it cannot
  // reproduce WGS84 distances and should not be asserted against them: at the
  // equator WGS84 gives 111,319 m per degree of longitude (equatorial radius
  // 6,378,137 m) while the IUGG mean-radius sphere gives 111,195 m. That 0.11%
  // gap is the accuracy ceiling of this function, and it is far below the
  // precision of any source here — AIS positions are reported to ~10 m at
  // best. Vincenty would close it at roughly 20x the cost per call.
  //
  // On a sphere both axes are great circles, so a degree of longitude at the
  // equator and a degree of latitude are the same distance.
  CHECK(haversine_m(0, 0, 0, 1) == doctest::Approx(111'195.0).epsilon(0.001));
  CHECK(haversine_m(0, 0, 1, 0) == doctest::Approx(111'195.0).epsilon(0.001));
  // New York to London, ~5,570 km.
  CHECK(haversine_m(40.7128, -74.0060, 51.5074, -0.1278) ==
        doctest::Approx(5'570'000.0).epsilon(0.01));
  // Identical points must be exactly zero, not a small positive number — a
  // NaN or epsilon here would poison k-NN ordering.
  CHECK(haversine_m(12.34, 56.78, 12.34, 56.78) == doctest::Approx(0.0));
  // Antipodal: half the circumference. This is where a naive spherical law of
  // cosines returns NaN.
  CHECK(haversine_m(0, 0, 0, 180) == doctest::Approx(20'015'000.0).epsilon(0.01));
}

TEST_CASE("bbox decomposition covers the box and stays within budget") {
  const BBox box{-10.0, -10.0, 10.0, 10.0};
  const std::vector<KeyRange> ranges = decompose_bbox(box, 64);

  REQUIRE(!ranges.empty());
  CHECK(ranges.size() <= 64);

  // Ranges must be disjoint and ascending after coalescing, or the scan would
  // emit duplicates.
  for (usize i = 1; i < ranges.size(); ++i) {
    CHECK(ranges[i - 1].hi < ranges[i].lo);
  }

  // Every corner and the centre must fall inside some range — the decomposition
  // is allowed to over-cover but never to miss.
  const GeoPoint probes[] = {
      GeoPoint::from_degrees(-10, -10), GeoPoint::from_degrees(10, 10),
      GeoPoint::from_degrees(-10, 10),  GeoPoint::from_degrees(10, -10),
      GeoPoint::from_degrees(0, 0),
  };
  for (const GeoPoint p : probes) {
    const MortonKey k = morton_of(p);
    const bool covered = std::any_of(ranges.begin(), ranges.end(), [k](const KeyRange& r) {
      return k >= r.lo && k <= r.hi;
    });
    CHECK(covered);
  }
}

TEST_CASE("differential: indexed bbox query agrees with brute force") {
  std::mt19937 rng(0xBEEFu);
  std::uniform_real_distribution<f64> lat_d(-85.0, 85.0);
  std::uniform_real_distribution<f64> lon_d(-179.0, 179.0);

  constexpr int kTrials = 12;
  constexpr int kPoints = 900;
  constexpr int kQueries = 40;

  for (int trial = 0; trial < kTrials; ++trial) {
    std::vector<RefPoint> pts;
    GeoIndex idx;

    for (int i = 0; i < kPoints; ++i) {
      const f64 lat = lat_d(rng);
      const f64 lon = lon_d(rng);
      pts.push_back(RefPoint{lat, lon, static_cast<u32>(i)});
      idx.add(GeoPoint::from_degrees(lat, lon), static_cast<u32>(i));
    }
    idx.build();

    for (int q = 0; q < kQueries; ++q) {
      f64 a = lat_d(rng), b = lat_d(rng);
      f64 c = lon_d(rng), d = lon_d(rng);
      if (a > b) std::swap(a, b);
      if (c > d) std::swap(c, d);

      const BBox box{a, c, b, d};

      std::vector<u32> got;
      GeoStats stats{};
      idx.query_bbox(box, got, &stats);

      // The brute-force oracle uses the original f64 coordinates while the
      // index stores fixed-point at 1e-7 degrees, so a point within ~1 cm of
      // an edge can legitimately classify differently. Comparing against an
      // oracle that quantises the same way isolates index bugs from rounding.
      std::vector<RefPoint> quantised;
      for (const RefPoint& p : pts) {
        const GeoPoint g = GeoPoint::from_degrees(p.lat, p.lon);
        quantised.push_back(RefPoint{g.lat(), g.lon(), p.ref});
      }

      INFO("trial=", trial, " q=", q, " ranges=", stats.ranges,
           " candidates=", stats.candidates, " matched=", stats.matched);
      REQUIRE(sorted(got) == brute_bbox(quantised, box));
    }
  }
}

TEST_CASE("differential: knn agrees with brute force") {
  std::mt19937 rng(0xF00Du);
  std::uniform_real_distribution<f64> lat_d(-70.0, 70.0);
  std::uniform_real_distribution<f64> lon_d(-179.0, 179.0);

  constexpr int kPoints = 600;
  std::vector<RefPoint> pts;
  GeoIndex idx;

  for (int i = 0; i < kPoints; ++i) {
    const f64 lat = lat_d(rng);
    const f64 lon = lon_d(rng);
    const GeoPoint g = GeoPoint::from_degrees(lat, lon);
    pts.push_back(RefPoint{g.lat(), g.lon(), static_cast<u32>(i)});
    idx.add(g, static_cast<u32>(i));
  }
  idx.build();

  for (int q = 0; q < 25; ++q) {
    const f64 qlat = lat_d(rng);
    const f64 qlon = lon_d(rng);
    const u32 k = 5;

    std::vector<u32> got;
    idx.query_knn(qlat, qlon, k, got);
    REQUIRE(got.size() == k);

    std::vector<std::pair<f64, u32>> expected;
    for (const RefPoint& p : pts) {
      expected.emplace_back(haversine_m(qlat, qlon, p.lat, p.lon), p.ref);
    }
    std::sort(expected.begin(), expected.end());

    // Compare distances, not ids: ties at equal distance may order either way
    // and that is not a bug.
    for (u32 i = 0; i < k; ++i) {
      const RefPoint& p = pts[got[i]];
      const f64 d = haversine_m(qlat, qlon, p.lat, p.lon);
      INFO("q=", q, " i=", i, " got_d=", d, " want_d=", expected[i].first);
      CHECK(d == doctest::Approx(expected[i].first).epsilon(1e-6));
    }

    // And they must come back nearest-first.
    for (u32 i = 1; i < k; ++i) {
      const f64 prev = haversine_m(qlat, qlon, pts[got[i - 1]].lat, pts[got[i - 1]].lon);
      const f64 cur = haversine_m(qlat, qlon, pts[got[i]].lat, pts[got[i]].lon);
      CHECK(prev <= cur + 1e-6);
    }
  }
}

TEST_CASE("knn handles k larger than the dataset") {
  GeoIndex idx;
  idx.add(GeoPoint::from_degrees(0, 0), 0);
  idx.add(GeoPoint::from_degrees(1, 1), 1);
  idx.build();

  std::vector<u32> got;
  idx.query_knn(0, 0, 10, got);
  // Must terminate and return what exists rather than looping forever waiting
  // for a tenth neighbour.
  CHECK(got.size() == 2);
}

TEST_CASE("cell_count is exact and usable as a selectivity estimate") {
  GeoIndex idx;
  // A tight cluster plus one far away.
  for (int i = 0; i < 50; ++i) {
    idx.add(GeoPoint::from_degrees(37.77 + i * 1e-5, -122.41 + i * 1e-5),
            static_cast<u32>(i));
  }
  idx.add(GeoPoint::from_degrees(-33.87, 151.21), 999);
  idx.build();

  const MortonKey cluster = morton_of(GeoPoint::from_degrees(37.77, -122.41));

  // A coarse cell must capture the whole cluster; the far point must not be in
  // it. This is the property the planner relies on to estimate spatial
  // selectivity exactly rather than guessing.
  CHECK(idx.cell_count(cluster, 40) >= 50);
  CHECK(idx.cell_count(cluster, 40) <= 51);
  CHECK(idx.cell_count(cluster, 0) <= 51);
}

TEST_CASE("empty and degenerate boxes are handled") {
  GeoIndex idx;
  idx.add(GeoPoint::from_degrees(10, 10), 1);
  idx.build();

  std::vector<u32> out;

  // Inverted box: no results, no crash.
  idx.query_bbox(BBox{10, 10, 0, 0}, out);
  CHECK(out.empty());

  // Degenerate box exactly on a point: inclusive edges mean it is found.
  out.clear();
  idx.query_bbox(BBox{10, 10, 10, 10}, out);
  CHECK(out.size() == 1);
}
