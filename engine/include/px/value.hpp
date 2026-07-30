// ── px/value.hpp ────────────────────────────────────────────────────────────
// A tagged 8-byte value, plus the fixed-point encodings for geography and time.
//
// Stored struct-of-arrays: the 8-byte payloads live in one u64 column and the
// type tags in a parallel u8 column. Interleaving them would pad each value to
// 16 bytes and halve the number of rows per cache line on a scan that reads
// only the tag.
// ────────────────────────────────────────────────────────────────────────────
#pragma once

#include <bit>
#include <cmath>

#include "px/ids.hpp"
#include "px/prelude.hpp"

namespace px {

enum class Kind : u8 {
  Null = 0,
  Bool,
  I64,
  F64,
  Sym,   // SymbolId into the SymbolTable
  Geo,   // packed lat/lon, see GeoPoint
  Time,  // seconds since kEpoch
  Ref,   // EntityId
};

// ── time ───────────────────────────────────────────────────────────────────
//
// Seconds since 2000-01-01T00:00:00Z, as i32. That covers 1932 through 2068,
// which comfortably spans every source in scope and the lifetime of anything
// that will use this.
//
// Why 32-bit rather than the obvious 64: valid_from, valid_to, and the system
// bounds are four columns compared on every row of a scan. At 4 bytes each,
// one 128-bit SIMD register holds four rows' worth per column; at 8 bytes it
// holds two. The visibility predicate is memory-bound, so this is close to a
// straight doubling of scan throughput.
//
// The cost is one-second resolution. No source here reports sub-second times,
// so nothing is lost — but it is a real limit and it belongs in the README
// rather than in a comment nobody reads.
using Timestamp = i32;

constexpr Timestamp kTimeMin = -2'147'483'647;
constexpr Timestamp kTimeMax = 2'147'483'647;

/// Unix epoch seconds at 2000-01-01T00:00:00Z.
constexpr i64 kEpochUnix = 946'684'800;

constexpr Timestamp from_unix(i64 unix_seconds) noexcept {
  const i64 t = unix_seconds - kEpochUnix;
  if (t < kTimeMin) return kTimeMin;
  if (t > kTimeMax) return kTimeMax;
  return static_cast<Timestamp>(t);
}

constexpr i64 to_unix(Timestamp t) noexcept {
  return static_cast<i64>(t) + kEpochUnix;
}

// ── geography ──────────────────────────────────────────────────────────────
//
// Latitude and longitude as degrees x 1e7, stored as two i32 packed into the
// 8-byte payload. Range fits: 180e7 < 2^31. Precision is ~1.1 cm at the
// equator, which is far finer than any source reports.
//
// Integer storage is not just about size. The Morton index (Phase 4)
// interleaves the bits of these two integers directly, so the spatial index
// key derives from the stored representation with no float arithmetic and no
// rounding disagreement between the value and its index entry.

constexpr f64 kGeoScale = 1e7;

struct GeoPoint {
  i32 lat_e7 = 0;
  i32 lon_e7 = 0;

  [[nodiscard]] constexpr f64 lat() const noexcept {
    return static_cast<f64>(lat_e7) / kGeoScale;
  }
  [[nodiscard]] constexpr f64 lon() const noexcept {
    return static_cast<f64>(lon_e7) / kGeoScale;
  }

  [[nodiscard]] static GeoPoint from_degrees(f64 lat, f64 lon) noexcept {
    // Clamp rather than reject. Feeds occasionally emit 90.0000001 from their
    // own rounding, and refusing the record would lose real data over a
    // floating-point artefact. Genuinely out-of-range input is a validation
    // concern for the ingest layer, which has the context to report it.
    if (lat > 90.0) lat = 90.0;
    if (lat < -90.0) lat = -90.0;
    while (lon > 180.0) lon -= 360.0;
    while (lon < -180.0) lon += 360.0;
    return GeoPoint{static_cast<i32>(std::lround(lat * kGeoScale)),
                    static_cast<i32>(std::lround(lon * kGeoScale))};
  }
};

// ── the tagged value ───────────────────────────────────────────────────────

struct Value {
  u64 bits = 0;
  Kind kind = Kind::Null;

  [[nodiscard]] static constexpr Value null() noexcept { return {}; }

  [[nodiscard]] static constexpr Value boolean(bool b) noexcept {
    return {static_cast<u64>(b ? 1 : 0), Kind::Bool};
  }
  [[nodiscard]] static constexpr Value integer(i64 v) noexcept {
    return {static_cast<u64>(v), Kind::I64};
  }
  [[nodiscard]] static Value real(f64 v) noexcept {
    return {std::bit_cast<u64>(v), Kind::F64};
  }
  [[nodiscard]] static constexpr Value symbol(SymbolId s) noexcept {
    return {static_cast<u64>(s.v), Kind::Sym};
  }
  [[nodiscard]] static constexpr Value reference(EntityId e) noexcept {
    return {static_cast<u64>(e.v), Kind::Ref};
  }
  [[nodiscard]] static constexpr Value time(Timestamp t) noexcept {
    return {static_cast<u64>(static_cast<u32>(t)), Kind::Time};
  }
  [[nodiscard]] static constexpr Value geo(GeoPoint g) noexcept {
    const u64 lat = static_cast<u64>(static_cast<u32>(g.lat_e7));
    const u64 lon = static_cast<u64>(static_cast<u32>(g.lon_e7));
    return {(lat << 32) | lon, Kind::Geo};
  }

  [[nodiscard]] constexpr bool as_bool() const noexcept { return bits != 0; }
  [[nodiscard]] constexpr i64 as_i64() const noexcept { return static_cast<i64>(bits); }
  [[nodiscard]] f64 as_f64() const noexcept { return std::bit_cast<f64>(bits); }
  [[nodiscard]] constexpr SymbolId as_symbol() const noexcept {
    return SymbolId{static_cast<u32>(bits)};
  }
  [[nodiscard]] constexpr EntityId as_entity() const noexcept {
    return EntityId{static_cast<u32>(bits)};
  }
  [[nodiscard]] constexpr Timestamp as_time() const noexcept {
    return static_cast<Timestamp>(static_cast<u32>(bits));
  }
  [[nodiscard]] constexpr GeoPoint as_geo() const noexcept {
    return GeoPoint{static_cast<i32>(static_cast<u32>(bits >> 32)),
                    static_cast<i32>(static_cast<u32>(bits & 0xFFFF'FFFFull))};
  }

  [[nodiscard]] constexpr bool is_null() const noexcept { return kind == Kind::Null; }

  /// Bitwise equality within a kind. Note that NaN != NaN under this
  /// definition is *false* — two NaN payloads with identical bits compare
  /// equal. That is the right behaviour for a store (a value equals itself, so
  /// dedup and retraction matching work) and the wrong behaviour for IEEE
  /// arithmetic, so the query executor must not route float comparisons here.
  friend constexpr bool operator==(const Value& a, const Value& b) noexcept {
    return a.kind == b.kind && a.bits == b.bits;
  }
};

}  // namespace px
