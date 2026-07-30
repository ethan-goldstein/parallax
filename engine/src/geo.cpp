#include "px/geo.hpp"

#include <algorithm>
#include <cmath>

namespace px {

namespace {

constexpr f64 kEarthRadiusM = 6'371'008.8;  // IUGG mean radius
constexpr f64 kPi = 3.14159265358979323846;

constexpr f64 to_rad(f64 deg) noexcept {
  return deg * kPi / 180.0;
}

/// Box-corner conversion: clamps to the valid range rather than wrapping.
i32 clamp_lat_e7(f64 deg) noexcept {
  const f64 c = std::clamp(deg, -90.0, 90.0);
  return static_cast<i32>(std::lround(c * kGeoScale));
}
i32 clamp_lon_e7(f64 deg) noexcept {
  const f64 c = std::clamp(deg, -180.0, 180.0);
  return static_cast<i32>(std::lround(c * kGeoScale));
}

/// One node of the quadtree walk: a cell covering [lat_lo, lat_hi] x
/// [lon_lo, lon_hi] in biased integer space, at `level` bits of precision.
struct Cell {
  u32 lat_lo, lat_hi, lon_lo, lon_hi;
  u32 level;  // remaining bits per axis; 0 means a single point
};

enum class Overlap { None, Full, Partial };

Overlap classify(const Cell& c, u32 q_lat_lo, u32 q_lat_hi, u32 q_lon_lo,
                 u32 q_lon_hi) noexcept {
  if (c.lat_hi < q_lat_lo || c.lat_lo > q_lat_hi) return Overlap::None;
  if (c.lon_hi < q_lon_lo || c.lon_lo > q_lon_hi) return Overlap::None;
  if (c.lat_lo >= q_lat_lo && c.lat_hi <= q_lat_hi && c.lon_lo >= q_lon_lo &&
      c.lon_hi <= q_lon_hi) {
    return Overlap::Full;
  }
  return Overlap::Partial;
}

/// Merges ranges that touch or overlap. The walk emits ranges in ascending
/// order, so one linear pass suffices — and adjacent quadtree cells very often
/// are contiguous in Z order, which is exactly when merging pays.
void coalesce(std::vector<KeyRange>& ranges) {
  if (ranges.size() < 2) return;
  std::sort(ranges.begin(), ranges.end(),
            [](const KeyRange& a, const KeyRange& b) { return a.lo < b.lo; });

  usize w = 0;
  for (usize r = 1; r < ranges.size(); ++r) {
    // +1 catches exactly-adjacent ranges. hi == U64_MAX cannot occur here
    // because the biased coordinate space does not reach the top of the
    // interleaved range, so the increment is safe.
    if (ranges[r].lo <= ranges[w].hi + 1) {
      ranges[w].hi = std::max(ranges[w].hi, ranges[r].hi);
    } else {
      ranges[++w] = ranges[r];
    }
  }
  ranges.resize(w + 1);
}

}  // namespace

f64 haversine_m(f64 lat1, f64 lon1, f64 lat2, f64 lon2) noexcept {
  const f64 p1 = to_rad(lat1);
  const f64 p2 = to_rad(lat2);
  const f64 dp = to_rad(lat2 - lat1);
  const f64 dl = to_rad(lon2 - lon1);

  const f64 sdp = std::sin(dp * 0.5);
  const f64 sdl = std::sin(dl * 0.5);

  const f64 a = sdp * sdp + std::cos(p1) * std::cos(p2) * sdl * sdl;
  // std::asin(std::sqrt(a)) rather than atan2(sqrt(a), sqrt(1-a)): both are
  // stable here, and clamping guards against a slipping just past 1.0 through
  // floating-point error at antipodal points, where asin would return NaN.
  return 2.0 * kEarthRadiusM * std::asin(std::sqrt(std::min(a, 1.0)));
}

std::vector<KeyRange> decompose_bbox(const BBox& box, u32 max_ranges) {
  std::vector<KeyRange> ranges;
  if (box.min_lat > box.max_lat || box.min_lon > box.max_lon) return ranges;

  // CLAMP the corners; do not use GeoPoint::from_degrees here.
  //
  // from_degrees WRAPS longitude, which is right for a point (lon 181 really
  // is lon -179) and catastrophic for a box corner: a box reaching past the
  // antimeridian comes back with min_lon 175.8 and max_lon -175.8, i.e.
  // inverted, and the guard above then returns zero ranges. The query silently
  // finds nothing instead of finding everything.
  //
  // Callers that genuinely need to span the antimeridian split the box in two
  // (see query_knn); a single BBox is always west-to-east.
  const i32 lat_lo_e7 = clamp_lat_e7(box.min_lat);
  const i32 lat_hi_e7 = clamp_lat_e7(box.max_lat);
  const i32 lon_lo_e7 = clamp_lon_e7(box.min_lon);
  const i32 lon_hi_e7 = clamp_lon_e7(box.max_lon);

  const u32 q_lat_lo = lat_to_u32(lat_lo_e7);
  const u32 q_lat_hi = lat_to_u32(lat_hi_e7);
  const u32 q_lon_lo = lon_to_u32(lon_lo_e7);
  const u32 q_lon_hi = lon_to_u32(lon_hi_e7);

  // Explicit stack rather than recursion: depth is bounded at 32 but the
  // branching factor is 4, and a recursive version would need the same manual
  // budget check anyway. This also keeps the wasm stack out of it.
  std::vector<Cell> stack;
  stack.push_back(Cell{0u, 0xFFFF'FFFFu, 0u, 0xFFFF'FFFFu, 32u});

  while (!stack.empty()) {
    const Cell c = stack.back();
    stack.pop_back();

    const Overlap o = classify(c, q_lat_lo, q_lat_hi, q_lon_lo, q_lon_hi);
    if (o == Overlap::None) continue;

    // Fully inside, or out of budget, or fully subdivided: emit whole. When
    // this happens for a partial cell the exact test in query_bbox filters the
    // extras, so the budget trades scan time for range count and never
    // correctness.
    if (o == Overlap::Full || c.level == 0 ||
        ranges.size() + stack.size() >= max_ranges) {
      ranges.push_back(KeyRange{encode_morton(c.lat_lo, c.lon_lo),
                                encode_morton(c.lat_hi, c.lon_hi)});
      continue;
    }

    const u32 lat_mid = c.lat_lo + ((c.lat_hi - c.lat_lo) >> 1);
    const u32 lon_mid = c.lon_lo + ((c.lon_hi - c.lon_lo) >> 1);
    const u32 next = c.level - 1;

    stack.push_back(Cell{c.lat_lo, lat_mid, c.lon_lo, lon_mid, next});
    stack.push_back(Cell{c.lat_lo, lat_mid, lon_mid + 1, c.lon_hi, next});
    stack.push_back(Cell{lat_mid + 1, c.lat_hi, c.lon_lo, lon_mid, next});
    stack.push_back(Cell{lat_mid + 1, c.lat_hi, lon_mid + 1, c.lon_hi, next});
  }

  coalesce(ranges);
  return ranges;
}

// ── GeoIndex ───────────────────────────────────────────────────────────────

void GeoIndex::clear() {
  entries_.clear();
  built_ = false;
}

void GeoIndex::reserve(usize n) {
  entries_.reserve(n);
}

void GeoIndex::add(GeoPoint g, u32 ref) {
  entries_.push_back(Entry{morton_of(g), ref, g.lat_e7, g.lon_e7});
  built_ = false;
}

void GeoIndex::build() {
  std::sort(entries_.begin(), entries_.end(),
            [](const Entry& a, const Entry& b) { return a.key < b.key; });
  built_ = true;
}

void GeoIndex::collect(const BBox& box, std::vector<u32>& out_idx, GeoStats* stats) const {
  PX_ASSERT(built_, "GeoIndex query before build()");

  GeoStats local{};
  const std::vector<KeyRange> ranges = decompose_bbox(box);
  local.ranges = static_cast<u32>(ranges.size());

  for (const KeyRange& r : ranges) {
    const auto begin =
        std::lower_bound(entries_.begin(), entries_.end(), r.lo,
                         [](const Entry& e, MortonKey k) { return e.key < k; });
    const auto end = std::upper_bound(entries_.begin(), entries_.end(), r.hi,
                                      [](MortonKey k, const Entry& e) { return k < e.key; });

    for (auto it = begin; it != end; ++it) {
      ++local.candidates;
      // The exact test. Z-ranges over-cover, so this is not optional — it is
      // what makes the result correct rather than approximately correct.
      if (box.contains(GeoPoint{it->lat_e7, it->lon_e7})) {
        out_idx.push_back(static_cast<u32>(it - entries_.begin()));
        ++local.matched;
      }
    }
  }

  if (stats) *stats = local;
}

void GeoIndex::query_bbox(const BBox& box, std::vector<u32>& out, GeoStats* stats) const {
  std::vector<u32> idx;
  collect(box, idx, stats);
  for (const u32 i : idx) out.push_back(entries_[i].ref);
}

void GeoIndex::query_knn(f64 lat, f64 lon, u32 k, std::vector<u32>& out,
                         GeoStats* stats) const {
  PX_ASSERT(built_, "GeoIndex::query_knn before build()");
  if (k == 0 || entries_.empty()) return;

  GeoStats local{};

  // Start at roughly 10 km and double. Correctness never depends on the
  // starting guess — only the iteration count does.
  f64 radius_m = 10'000.0;
  constexpr f64 kMaxRadiusM = 20'037'508.0;  // half the equatorial circumference

  std::vector<u32> idx;
  std::vector<std::pair<f64, u32>> scored;
  std::vector<BBox> boxes;

  for (;;) {
    idx.clear();
    scored.clear();
    boxes.clear();

    // Degrees of latitude are constant; degrees of longitude shrink with
    // cos(lat). Without that correction a 50 km window at 70 N would be a
    // third as wide as intended and would silently miss neighbours.
    const f64 dlat = (radius_m / kEarthRadiusM) * 180.0 / kPi;
    const f64 coslat = std::max(std::cos(to_rad(lat)), 1e-6);
    const f64 dlon = dlat / coslat;

    const f64 lat_lo = std::max(lat - dlat, -90.0);
    const f64 lat_hi = std::min(lat + dlat, 90.0);

    // A BBox is always west-to-east, so a window overlapping the antimeridian
    // becomes TWO boxes rather than one inverted one. Getting this wrong is
    // what made k-NN return points 12,000 km away: the box inverted, matched
    // nothing, and the radius kept doubling until the answer was noise.
    if (dlon >= 180.0) {
      boxes.push_back(BBox{lat_lo, -180.0, lat_hi, 180.0});
    } else if (lon - dlon < -180.0) {
      boxes.push_back(BBox{lat_lo, -180.0, lat_hi, lon + dlon});
      boxes.push_back(BBox{lat_lo, lon - dlon + 360.0, lat_hi, 180.0});
    } else if (lon + dlon > 180.0) {
      boxes.push_back(BBox{lat_lo, lon - dlon, lat_hi, 180.0});
      boxes.push_back(BBox{lat_lo, -180.0, lat_hi, lon + dlon - 360.0});
    } else {
      boxes.push_back(BBox{lat_lo, lon - dlon, lat_hi, lon + dlon});
    }

    for (const BBox& b : boxes) {
      GeoStats pass{};
      collect(b, idx, &pass);
      local.ranges += pass.ranges;
      local.candidates += pass.candidates;
    }

    for (const u32 i : idx) {
      const Entry& e = entries_[i];
      const GeoPoint g{e.lat_e7, e.lon_e7};
      // Exact distance, which is what keeps the answer correct despite the
      // rectangular over-fetch and Z-order distortion above.
      const f64 d = haversine_m(lat, lon, g.lat(), g.lon());
      if (d <= radius_m) scored.emplace_back(d, e.ref);
    }

    // Accept only once k are inside the CIRCLE, not merely inside the box —
    // otherwise a point in a box corner could displace a nearer one just
    // outside it.
    if (scored.size() >= k || radius_m >= kMaxRadiusM) break;
    radius_m *= 2.0;
  }

  const usize take = std::min<usize>(k, scored.size());
  std::partial_sort(scored.begin(), scored.begin() + static_cast<ptrdiff_t>(take),
                    scored.end());

  for (usize i = 0; i < take; ++i) out.push_back(scored[i].second);
  local.matched = static_cast<u32>(take);
  if (stats) *stats = local;
}

u32 GeoIndex::estimate_range_rows(const BBox& box, u32* ranges_out) const noexcept {
  if (!built_) {
    if (ranges_out) *ranges_out = 0;
    return 0;
  }

  const std::vector<KeyRange> ranges = decompose_bbox(box);
  if (ranges_out) *ranges_out = static_cast<u32>(ranges.size());

  u32 total = 0;
  for (const KeyRange& r : ranges) {
    // Two binary searches per range, no scanning. The count is exact for the
    // key ranges; it over-counts the BOX by exactly the Z-order false
    // positives, which is a bounded and known direction of error.
    const auto begin = std::lower_bound(entries_.begin(), entries_.end(), r.lo,
                                        [](const Entry& e, MortonKey k) { return e.key < k; });
    const auto end = std::upper_bound(entries_.begin(), entries_.end(), r.hi,
                                      [](MortonKey k, const Entry& e) { return k < e.key; });
    total += static_cast<u32>(end - begin);
  }
  return total;
}

u32 GeoIndex::cell_count(MortonKey key, u32 level) const noexcept {
  if (!built_ || level >= 64) return 0;

  const MortonKey mask = (level == 0) ? ~MortonKey{0} : (~MortonKey{0} << level);
  const MortonKey lo = key & mask;
  const MortonKey hi = lo | ~mask;

  const auto begin = std::lower_bound(entries_.begin(), entries_.end(), lo,
                                      [](const Entry& e, MortonKey k) { return e.key < k; });
  const auto end = std::upper_bound(entries_.begin(), entries_.end(), hi,
                                    [](MortonKey k, const Entry& e) { return k < e.key; });
  return static_cast<u32>(end - begin);
}

}  // namespace px
