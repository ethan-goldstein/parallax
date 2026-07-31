#include "px/session.hpp"

#include <cstring>

#include "px/bench.hpp"
#include "px/ql/parser.hpp"

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

  // Indexes are NOT rebuilt here. Rebuilding per batch is O(batches x facts):
  // with 2,841 transactions over 11,811 facts that measured 9.7 SECONDS of
  // ingest, because each of 2,841 batches re-scanned and re-sorted everything.
  // The caller rebuilds once, after the last batch, via finish_ingest().
  //
  // Correctness does not depend on remembering: as_of_entity falls back to a
  // scan while the entity index is stale, and the planner simply will not
  // consider GeoRangeScan while the spatial index is unbuilt. A forgotten
  // rebuild is a performance bug, never a wrong answer.
  return result;
}

void Session::finish_ingest() {
  store_.rebuild_entity_index();
  rebuild_geo_index();
}

void Session::rebuild_geo_index() {
  geo_.clear();
  geo_.reserve(store_.fact_count());

  // Indexed by FactId, not by entity. The spatial index answers "where", and
  // the bitemporal predicate answers "when" — keeping them separate means a
  // geo query returns candidates that still have to pass visible_at(), rather
  // than the index having to be rebuilt for every point on the time axes.
  for (u32 i = 0; i < static_cast<u32>(store_.fact_count()); ++i) {
    const FactId f{i};
    const Value v = store_.fact_value(f);
    if (v.kind != Kind::Geo) continue;
    geo_.add(v.as_geo(), i);
  }
  geo_.build();
}

er::ErStats Session::resolve_entities(SymbolId geo_attr, SymbolId scalar_attr) {
  const Timestamp valid_at = kTimeMax - 1;  // "everything that has happened"
  const u32 sys_at = store_.current_txn().v;

  // Build one record per entity from what is ACTUALLY IN THE STORE, rather
  // than from the feed clients. Resolving a parallel copy would let the two
  // drift, and it would also lose the SourceId — which the model needs, since
  // same-source pairs are never merged.
  scratch_.clear();
  store_.as_of(valid_at, TxnId{sys_at}, scratch_);

  std::vector<er::Record> records;
  record_entity_.clear();
  std::vector<u32> slot;  // entity index -> record index

  for (const FactId f : scratch_) {
    if (store_.fact_attr(f) != geo_attr) continue;
    const Value v = store_.fact_value(f);
    if (v.kind != Kind::Geo) continue;

    const EntityId e = store_.fact_entity(f);
    if (e.index() >= slot.size()) slot.resize(e.index() + 1, 0xFFFF'FFFFu);
    if (slot[e.index()] != 0xFFFF'FFFFu) continue;  // first position wins

    er::Record r;
    r.id = static_cast<u32>(records.size());
    r.source = static_cast<u16>(store_.fact_source(f).v);
    r.position = v.as_geo();
    // Valid-from IS the event's origin time — the instant the fact became
    // true — so the temporal comparator reads it straight off the store rather
    // than needing a separate attribute.
    r.time = store_.fact_valid_from(f);

    slot[e.index()] = r.id;
    record_entity_.push_back(e.v);
    records.push_back(r);
  }

  // Second pass for the scalar, now that record indices exist.
  if (scalar_attr.valid()) {
    for (const FactId f : scratch_) {
      if (store_.fact_attr(f) != scalar_attr) continue;
      const EntityId e = store_.fact_entity(f);
      if (e.index() >= slot.size() || slot[e.index()] == 0xFFFF'FFFFu) continue;

      const Value v = store_.fact_value(f);
      er::Record& r = records[slot[e.index()]];
      if (v.kind == Kind::F64) {
        r.magnitude = v.as_f64();
        r.has_magnitude = true;
      } else if (v.kind == Kind::I64) {
        r.magnitude = static_cast<f64>(v.as_i64());
        r.has_magnitude = true;
      }
    }
  }

  resolution_ = er::resolve(records, er::ErConfig{}, &store_.symbols());
  return resolution_.stats;
}

void Session::unmerge_pair(u32 pair_index) {
  er::unmerge(resolution_, pair_index);
}

namespace {

void json_str(std::string& out, const std::string& v) {
  out += '"';
  for (const char c : v) {
    if (c == '"') out += "\\\"";
    else if (c == '\\') out += "\\\\";
    else if (static_cast<unsigned char>(c) < 0x20) out += ' ';
    else out += c;
  }
  out += '"';
}

void json_num(std::string& out, f64 v) {
  char buf[48];
  std::snprintf(buf, sizeof(buf), "%.4g", v);
  out += buf;
}

}  // namespace

std::string Session::merge_evidence_json(u32 limit) const {
  std::string s;
  s.reserve(4096);
  s += "{\"stats\":{";
  s += "\"records\":" + std::to_string(resolution_.stats.records);
  s += ",\"pairsCompared\":" + std::to_string(resolution_.stats.pairs_compared);
  s += ",\"pairsAccepted\":" + std::to_string(resolution_.stats.pairs_accepted);
  s += ",\"clusters\":" + std::to_string(resolution_.stats.clusters);
  s += ",\"mergedRecords\":" + std::to_string(resolution_.stats.merged_records);
  s += ",\"blocks\":" + std::to_string(resolution_.stats.blocks);
  s += ",\"blocksSkipped\":" + std::to_string(resolution_.stats.blocks_skipped);
  s += ",\"elapsedMs\":";
  json_num(s, resolution_.stats.elapsed_ms);
  s += "},\"merges\":[";

  u32 emitted = 0;
  for (usize i = 0; i < resolution_.accepted.size() && emitted < limit; ++i) {
    const er::Pair& p = resolution_.accepted[i];
    if (emitted) s += ',';
    s += "{\"pairIndex\":" + std::to_string(i);
    s += ",\"a\":" + std::to_string(p.a);
    s += ",\"b\":" + std::to_string(p.b);
    s += ",\"score\":";
    json_num(s, p.score);
    s += ",\"evidence\":[";
    for (usize k = 0; k < p.evidence.size(); ++k) {
      const er::MatchEvidence& e = p.evidence[k];
      if (k) s += ',';
      s += "{\"field\":";
      json_str(s, er::comparator_name(e.comparator));
      s += ",\"a\":";
      json_str(s, e.a_value);
      s += ",\"b\":";
      json_str(s, e.b_value);
      s += ",\"contribution\":";
      json_num(s, e.contribution);
      s += ",\"agreed\":";
      s += e.agreed ? "true" : "false";
      s += '}';
    }
    s += "]}";
    ++emitted;
  }

  s += "]}";
  return s;
}

void Session::register_source(std::string_view name, SymbolId geo_attr,
                              SymbolId scalar_attr) {
  for (SourceBinding& b : sources_) {
    if (b.name == name) {
      b.geo_attr = geo_attr;
      b.scalar_attr = scalar_attr;
      return;
    }
  }
  sources_.push_back(SourceBinding{std::string(name), geo_attr, scalar_attr});
}

Session::QueryOutcome Session::run_query(std::string_view sql, i64 now_unix) {
  QueryOutcome out;
  out.batch.generation = generation_;

  ql::ParseResult pr = ql::parse(sql);
  if (pr.error.failed) {
    out.error = pr.error.message;
    out.error_begin = pr.error.begin;
    out.error_end = pr.error.end;
    return out;
  }

  const SourceBinding* binding = nullptr;
  for (const SourceBinding& b : sources_) {
    if (b.name == pr.query.source) binding = &b;
  }
  if (binding == nullptr) {
    std::string known;
    for (const SourceBinding& b : sources_) {
      if (!known.empty()) known += ", ";
      known += b.name;
    }
    out.error = "unknown source `" + pr.query.source + "` — try: " + known;
    out.error_begin = 0;
    out.error_end = static_cast<u32>(pr.query.source.size());
    return out;
  }

  ql::PlanContext ctx;
  ctx.store = &store_;
  ctx.geo = &geo_;
  ctx.now_unix = now_unix;
  ctx.geo_attr = binding->geo_attr;
  ctx.scalar_attr = binding->scalar_attr;
  ctx.current_txn = store_.current_txn().v;

  ql::Plan plan = ql::plan_query(pr.query, ctx);
  if (!plan.ok()) {
    out.error = plan.error.empty() ? "could not plan this query" : plan.error;
    return out;
  }

  scratch_.clear();
  {
    ScopedTimer timer(last_query_ms_);
    ql::execute(plan, ctx, pr.query, scratch_);
  }

  // Pack the surviving geometry facts, resolving each entity's scalar through
  // the same index pass used by query_points.
  ++query_stamp_;
  if (binding->scalar_attr.valid()) {
    std::vector<FactId> attrs;
    for (const FactId f : scratch_) {
      const EntityId e = store_.fact_entity(f);
      attrs.clear();
      store_.as_of_entity(e, plan.valid_at, TxnId{plan.sys_at}, attrs);
      for (const FactId a : attrs) {
        if (store_.fact_attr(a) != binding->scalar_attr) continue;
        const Value av = store_.fact_value(a);
        f32 s = 0.0f;
        if (av.kind == Kind::F64) s = static_cast<f32>(av.as_f64());
        else if (av.kind == Kind::I64) s = static_cast<f32>(av.as_i64());
        if (e.index() >= scalar_by_entity_.size()) {
          scalar_by_entity_.resize(e.index() + 1, 0.0f);
          scalar_stamp_.resize(e.index() + 1, 0u);
        }
        scalar_by_entity_[e.index()] = s;
        scalar_stamp_[e.index()] = query_stamp_;
        break;
      }
    }
  }

  u32 written = 0;
  u32 truncated = 0;
  for (const FactId f : scratch_) {
    if (written >= point_capacity_) {
      truncated = 1;
      break;
    }
    const Value v = store_.fact_value(f);
    if (v.kind != Kind::Geo) continue;

    const GeoPoint g = v.as_geo();
    const usize e = store_.fact_entity(f).index();
    const f32 scalar =
        (e < scalar_stamp_.size() && scalar_stamp_[e] == query_stamp_) ? scalar_by_entity_[e]
                                                                      : 0.0f;
    points_[written] =
        wire::Point{static_cast<f32>(g.lat()), static_cast<f32>(g.lon()), scalar, f.v};
    ++written;
  }

  out.batch = PointBatch{points_.data(), written, generation_, truncated};
  out.explain = ql::explain_json(plan);
  out.ok = true;
  return out;
}

Session::PointBatch Session::query_points(Timestamp valid_at, u32 sys_at,
                                          SymbolId geo_attr, SymbolId scalar_attr) {
  scratch_.clear();

  u32 written = 0;
  u32 truncated = 0;

  {
    ScopedTimer timer(last_query_ms_);

    store_.as_of(valid_at, TxnId{sys_at}, scratch_, &last_scan_);

    // Pass 1 — index the scalar attribute by entity.
    //
    // The obvious implementation looks up each point's scalar with a second
    // as_of_entity() call inside the emit loop. That was the first version and
    // it measured 8.8 ms for 7k facts, because it allocated a std::vector per
    // point: ~3.7 us each, entirely in malloc, for work the result set already
    // contained.
    //
    // Both attributes are in `scratch_` already — they were returned by the
    // same bitemporal slice. So index them in one linear pass instead.
    //
    // The index is a flat array subscripted by entity id, which is only viable
    // because entity ids are dense (EntityRegistry in usgs.ts hands out
    // sequential ids for exactly this reason). Stamping with a per-query
    // counter avoids clearing the array between queries — a memset of a
    // 100k-entry array on every scrubber tick would reintroduce the cost this
    // is removing.
    ++query_stamp_;
    if (scalar_attr.valid()) {
      for (const FactId f : scratch_) {
        if (store_.fact_attr(f) != scalar_attr) continue;

        const Value av = store_.fact_value(f);
        f32 s;
        if (av.kind == Kind::F64) s = static_cast<f32>(av.as_f64());
        else if (av.kind == Kind::I64) s = static_cast<f32>(av.as_i64());
        else continue;

        const usize e = store_.fact_entity(f).index();
        if (e >= scalar_by_entity_.size()) {
          scalar_by_entity_.resize(e + 1, 0.0f);
          scalar_stamp_.resize(e + 1, 0u);
        }
        scalar_by_entity_[e] = s;
        scalar_stamp_[e] = query_stamp_;
      }
    }

    // Pass 2 — emit the geo facts, reading scalars from the index.
    //
    // Bitemporally consistent by construction: both attributes came out of one
    // as_of(T, S), so a point can never show one instant's magnitude at
    // another instant's position.
    for (const FactId f : scratch_) {
      if (written >= point_capacity_) {
        truncated = 1;
        break;
      }
      if (store_.fact_attr(f) != geo_attr) continue;

      const Value v = store_.fact_value(f);
      if (v.kind != Kind::Geo) continue;

      const GeoPoint g = v.as_geo();
      const usize e = store_.fact_entity(f).index();

      const f32 scalar =
          (e < scalar_stamp_.size() && scalar_stamp_[e] == query_stamp_) ? scalar_by_entity_[e]
                                                                        : 0.0f;

      points_[written] = wire::Point{static_cast<f32>(g.lat()), static_cast<f32>(g.lon()),
                                     scalar, f.v};
      ++written;
    }
  }

  return PointBatch{points_.data(), written, generation_, truncated};
}

}  // namespace px
