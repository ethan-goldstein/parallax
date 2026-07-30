// ── px/geo.hpp ──────────────────────────────────────────────────────────────
// Z-order (Morton) spatial index over the fixed-point coordinates already
// stored in Value.
//
// ── why Z-order, and what it costs ─────────────────────────────────────────
//
// The alternatives, weighed honestly, because the reasoning is the artifact
// here rather than the code:
//
//   S2       — cube-face projection plus a Hilbert curve. Better locality than
//              Z-order (Hilbert has no long-range jumps), and it handles poles
//              correctly. It is also ~400 lines of subtle spherical geometry
//              that takes a week to get right and longer to be confident in.
//   H3       — means vendoring a C library. Apache-2.0, so no license problem,
//              but its icosahedral math is opaque enough that I could not
//              explain a query plan built on it in an interview, which defeats
//              the purpose of building this at all.
//   R-tree   — the textbook answer for bounding boxes, but node splitting and
//              rebalancing are genuinely fiddly, and a subtly wrong split
//              produces wrong results rather than slow ones.
//   k-d tree — simplest, and excellent for k-NN, but poor under streaming
//              inserts, which the live-feed story requires.
//
//   Morton   — the key is interleave(lat_q, lon_q) over the i32 values the
//              store already holds. Sorted array plus binary search. ~120
//              lines, and every step is explainable.
//
// The two real flaws, stated plainly and measured rather than hand-waved:
//
//   1. Z-order has locality discontinuities. When the curve crosses a quadrant
//      boundary it jumps across the map, so a query box that straddles one is
//      split into several disjoint ranges. Hilbert does not have this. The
//      decomposition below handles it by emitting multiple ranges instead of
//      one, and reports how many — which turns a weakness into an EXPLAIN
//      statistic.
//   2. Equirectangular quantisation distorts near the poles: a cell spans far
//      less ground east-west at 80 degrees than at the equator. Irrelevant for
//      every source in scope (no seismic, AIS, or ADS-B data is polar), and
//      the k-NN path refines with exact haversine anyway, so distance answers
//      stay correct even where cell shapes do not.
//
// Bonus, and the reason this pays for itself three times over: coarse Morton
// cells double as entity-resolution blocking keys, and per-cell counts give
// the query planner an EXACT spatial selectivity estimate rather than a guess.
// One structure, three uses.
// ────────────────────────────────────────────────────────────────────────────
#pragma once

#include <vector>

#include "px/ids.hpp"
#include "px/prelude.hpp"
#include "px/value.hpp"

namespace px {

/// Interleaved 64-bit key: 32 bits of latitude and 32 of longitude.
using MortonKey = u64;

// The stored fixed-point coordinates are signed and centred on zero. Morton
// interleaving needs unsigned values whose numeric order matches spatial
// order, so both axes are biased into the non-negative range.
//
// lat_e7 in [-9e8, 9e8]  -> [0, 1.8e9]
// lon_e7 in [-1.8e9, 1.8e9] -> [0, 3.6e9]
//
// Both fit in u32 (max 4.29e9). The 2:1 range ratio is simply the aspect ratio
// of an equirectangular projection and needs no correction.
constexpr u32 kLatBias = 900'000'000u;
constexpr u32 kLonBias = 1'800'000'000u;

[[nodiscard]] constexpr u32 lat_to_u32(i32 lat_e7) noexcept {
  return static_cast<u32>(static_cast<i64>(lat_e7) + kLatBias);
}
[[nodiscard]] constexpr u32 lon_to_u32(i32 lon_e7) noexcept {
  return static_cast<u32>(static_cast<i64>(lon_e7) + kLonBias);
}

/// Spreads the 32 bits of `v` into the even positions of a u64.
///
/// The standard five-step bit-twiddle: each round doubles the gaps between
/// bits. Branch-free and ~10 instructions, which matters because it runs once
/// per point on every index build.
[[nodiscard]] constexpr u64 spread_bits(u32 v) noexcept {
  u64 x = v;
  x = (x | (x << 16)) & 0x0000'FFFF'0000'FFFFull;
  x = (x | (x << 8)) & 0x00FF'00FF'00FF'00FFull;
  x = (x | (x << 4)) & 0x0F0F'0F0F'0F0F'0F0Full;
  x = (x | (x << 2)) & 0x3333'3333'3333'3333ull;
  x = (x | (x << 1)) & 0x5555'5555'5555'5555ull;
  return x;
}

/// Inverse of spread_bits: gathers the even-position bits back into a u32.
[[nodiscard]] constexpr u32 compact_bits(u64 x) noexcept {
  x &= 0x5555'5555'5555'5555ull;
  x = (x | (x >> 1)) & 0x3333'3333'3333'3333ull;
  x = (x | (x >> 2)) & 0x0F0F'0F0F'0F0F'0F0Full;
  x = (x | (x >> 4)) & 0x00FF'00FF'00FF'00FFull;
  x = (x | (x >> 8)) & 0x0000'FFFF'0000'FFFFull;
  x = (x | (x >> 16)) & 0x0000'0000'FFFF'FFFFull;
  return static_cast<u32>(x);
}

/// Latitude occupies the odd bits, longitude the even ones. The assignment is
/// arbitrary but must match decode_morton exactly.
[[nodiscard]] constexpr MortonKey encode_morton(u32 lat_u, u32 lon_u) noexcept {
  return (spread_bits(lat_u) << 1) | spread_bits(lon_u);
}

[[nodiscard]] constexpr MortonKey morton_of(GeoPoint g) noexcept {
  return encode_morton(lat_to_u32(g.lat_e7), lon_to_u32(g.lon_e7));
}

struct MortonXY {
  u32 lat_u;
  u32 lon_u;
};

[[nodiscard]] constexpr MortonXY decode_morton(MortonKey k) noexcept {
  return MortonXY{compact_bits(k >> 1), compact_bits(k)};
}

/// An axis-aligned query box in degrees. Half-open in neither direction —
/// geographic boxes are conventionally inclusive on both edges, and a point
/// exactly on a border should be returned.
struct BBox {
  f64 min_lat, min_lon, max_lat, max_lon;

  [[nodiscard]] bool contains(GeoPoint g) const noexcept {
    const f64 la = g.lat(), lo = g.lon();
    return la >= min_lat && la <= max_lat && lo >= min_lon && lo <= max_lon;
  }
};

/// A contiguous span of Morton keys. A box maps to several of these because
/// the Z curve leaves and re-enters the box at quadrant boundaries.
struct KeyRange {
  MortonKey lo;
  MortonKey hi;  // inclusive
};

/// Statistics from a spatial query, surfaced in EXPLAIN.
///
/// `candidates` minus `matched` is the false-positive count — points that fell
/// inside a Z-range but outside the actual box. That ratio is the honest
/// measure of how well Z-order is serving a given query shape, and publishing
/// it is more useful than claiming the index is good.
struct GeoStats {
  u32 ranges = 0;
  u32 candidates = 0;
  u32 matched = 0;
};

/// Decomposes `box` into at most `max_ranges` Morton key ranges.
///
/// Recursive quadtree subdivision: start from the smallest cell enclosing the
/// box, then split. A sub-cell entirely inside the box becomes one range; one
/// entirely outside is dropped; a partial one is subdivided further. When the
/// budget is exhausted, remaining partial cells are emitted whole and the
/// exact test filters them — so a low budget costs scan time, never
/// correctness.
[[nodiscard]] std::vector<KeyRange> decompose_bbox(const BBox& box, u32 max_ranges = 64);

/// Great-circle distance in metres, on a sphere of the IUGG mean radius.
///
/// Haversine rather than a flat-earth approximation, because a "vessels within
/// 50 km" query near the poles would otherwise be wrong by tens of percent. It
/// is also numerically stable for small distances, which the naive spherical
/// law of cosines is not.
///
/// Accuracy ceiling: the Earth is an ellipsoid, so this is off by up to ~0.5%
/// versus WGS84 (at the equator, 111,195 m per degree of longitude here vs
/// 111,319 m geodesic). That is well below the positional accuracy of every
/// source in scope. Vincenty's formulae would close the gap at roughly 20x the
/// cost per call, which is not a trade worth making for a viewport filter.
[[nodiscard]] f64 haversine_m(f64 lat1, f64 lon1, f64 lat2, f64 lon2) noexcept;

/// Sorted Morton index over a set of points.
///
/// Built in bulk by sorting, not maintained incrementally. Sorting 100k keys
/// is a few milliseconds and every ingest here is a batch, so an LSM-style
/// overflow buffer would be complexity bought for a workload that does not
/// exist.
class GeoIndex {
 public:
  void clear();
  void reserve(usize n);

  /// Records one point. `ref` is opaque to the index — the caller decides
  /// whether it is a FactId or a row number.
  void add(GeoPoint g, u32 ref);

  /// Sorts. Must be called before any query; queries assert on it in debug.
  void build();

  [[nodiscard]] bool built() const noexcept { return built_; }
  [[nodiscard]] usize size() const noexcept { return entries_.size(); }

  /// Appends refs whose points lie inside `box`.
  void query_bbox(const BBox& box, std::vector<u32>& out, GeoStats* stats = nullptr) const;

  /// Appends the `k` nearest refs to (lat, lon), nearest first.
  ///
  /// Expanding-radius bbox search, doubling until k candidates are found, then
  /// an exact haversine sort. The expansion is what keeps this correct despite
  /// Z-order's discontinuities: correctness comes from the exact refinement,
  /// and the index only has to be a good filter rather than a perfect one.
  void query_knn(f64 lat, f64 lon, u32 k, std::vector<u32>& out,
                 GeoStats* stats = nullptr) const;

  /// Number of indexed points sharing a coarse cell, used as an EXACT
  /// selectivity estimate by the planner and as a blocking key by entity
  /// resolution. `level` is how many low bits to mask off.
  [[nodiscard]] u32 cell_count(MortonKey key, u32 level) const noexcept;

 private:
  /// Shared scan path for bbox and k-NN. Emits INDICES into entries_ rather
  /// than refs, so k-NN can read coordinates directly instead of rescanning
  /// the whole index to find each candidate again.
  void collect(const BBox& box, std::vector<u32>& out_idx, GeoStats* stats) const;

  struct Entry {
    MortonKey key;
    u32 ref;
    i32 lat_e7;
    i32 lon_e7;
  };

  std::vector<Entry> entries_;
  bool built_ = false;
};

}  // namespace px
