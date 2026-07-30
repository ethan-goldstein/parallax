#include "px/session.hpp"

#include <cstring>

#include "px/bench.hpp"

namespace px {

Session::Session(u32 max_points) : point_capacity_(max_points) {
  // Allocated once, at full capacity, and never resized again.
  //
  // This is the load-bearing safety property of the whole boundary design.
  // JavaScript holds a Float32Array view over this memory across frames; if
  // the vector ever reallocated, that view would point at freed memory and
  // WebGL would render whatever now lives there. Fixing capacity up front
  // trades a bounded amount of memory (262,144 x 16 B = 4 MB by default) for
  // the elimination of an entire bug class.
  //
  // resize, not reserve: the memory must be live and owned now, not on first
  // push_back.
  points_.resize(max_points);
  scratch_.reserve(max_points);
}

u8* Session::staging_buffer(u32 bytes) {
  if (bytes > staging_.size()) {
    // Round up to a power of two so a feed that grows gradually does not
    // reallocate on nearly every batch.
    usize want = 4096;
    while (want < bytes) want <<= 1;

    staging_.resize(want);

    // The address almost certainly moved. Anything JS cached is now stale, and
    // bumping the generation is what turns that from silent corruption into a
    // detected mismatch on the next access.
    ++generation_;
  }
  return staging_.data();
}

IngestResult Session::ingest(u32 byte_offset, u32 byte_len, i64 wall_clock_unix) {
  IngestResult result{};

  // Both arguments come from JavaScript and are untrusted. Because they are
  // offsets into a buffer whose size we know, the check is a comparison
  // against that size — no pointer arithmetic, nothing that can wrap, and
  // identical semantics on a 32-bit and a 64-bit target.
  const usize size = staging_.size();
  if (byte_offset > size) return result;
  if (byte_len > size - byte_offset) return result;

  const u32 count = byte_len / static_cast<u32>(sizeof(wire::Fact));
  if (count == 0) return result;

  // memcpy into a properly aligned local rather than reinterpret_cast over the
  // raw bytes. std::vector<u8> guarantees no particular alignment, and reading
  // a u64 through a misaligned pointer is undefined behaviour — which on wasm
  // is not theoretical: it is exactly what -sSAFE_HEAP flags.
  const u8* src = staging_.data() + byte_offset;

  result.txn = store_.begin_txn(wall_clock_unix);

  for (u32 i = 0; i < count; ++i) {
    wire::Fact f{};
    std::memcpy(&f, src + static_cast<usize>(i) * sizeof(wire::Fact), sizeof(wire::Fact));

    // A Kind tag outside the enum would index a switch out of range downstream.
    if (f.vkind > static_cast<u8>(Kind::Ref)) {
      ++result.rejected;
      continue;
    }
    // Half-open intervals only. valid_from == valid_to is an empty interval
    // that can never be visible, so it is a producer bug worth counting rather
    // than storing.
    if (f.valid_from >= f.valid_to) {
      ++result.rejected;
      continue;
    }

    store_.assert_fact(EntityId{f.entity}, SymbolId{f.attr},
                       Value{f.vbits, static_cast<Kind>(f.vkind)}, f.valid_from,
                       f.valid_to, SourceId{f.source});
    ++result.accepted;
  }

  store_.commit_txn();
  store_.rebuild_entity_index();

  return result;
}

Session::PointBatch Session::query_points(Timestamp valid_at, u32 sys_at,
                                          SymbolId geo_attr, SymbolId scalar_attr) {
  scratch_.clear();

  u32 written = 0;
  u32 truncated = 0;

  {
    ScopedTimer timer(last_query_ms_);

    store_.as_of(valid_at, TxnId{sys_at}, scratch_, &last_scan_);

    // Two passes over the result set rather than one: collect the geo facts,
    // then look up each entity's scalar. Doing it in a single pass would mean
    // a hash map keyed by entity, and at these sizes the second lookup through
    // the CSR entity index is cheaper than building one.
    for (const FactId f : scratch_) {
      if (written >= point_capacity_) {
        truncated = 1;
        break;
      }
      if (store_.fact_attr(f) != geo_attr) continue;

      const Value v = store_.fact_value(f);
      if (v.kind != Kind::Geo) continue;

      const GeoPoint g = v.as_geo();
      const EntityId entity = store_.fact_entity(f);

      f32 scalar = 0.0f;
      if (scalar_attr.valid()) {
        // Bitemporally consistent by construction: the scalar is read at the
        // same (T, S) as the position, so a point never shows today's
        // magnitude at last week's location.
        std::vector<FactId> attrs;
        store_.as_of_entity(entity, valid_at, TxnId{sys_at}, attrs);
        for (const FactId a : attrs) {
          if (store_.fact_attr(a) != scalar_attr) continue;
          const Value av = store_.fact_value(a);
          if (av.kind == Kind::F64) scalar = static_cast<f32>(av.as_f64());
          else if (av.kind == Kind::I64) scalar = static_cast<f32>(av.as_i64());
          break;
        }
      }

      points_[written] = wire::Point{static_cast<f32>(g.lat()), static_cast<f32>(g.lon()),
                                     scalar, f.v};
      ++written;
    }
  }

  return PointBatch{points_.data(), written, generation_, truncated};
}

}  // namespace px
