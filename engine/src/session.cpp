#include "px/session.hpp"

#include <cstring>

#include "px/bench.hpp"
#include "px/ql/parser.hpp"

namespace px {

namespace {

void json_str(std::string& out, std::string_view v) {
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

bool Session::set_purpose(std::string_view name) {
  Purpose p{};
  if (!parse_purpose(name, p)) return false;
  policy_.set_purpose(p);
  return true;
}

void Session::record_audit(std::string_view query, const PolicyDecision& decision,
                           u32 rows_returned, i64 wall_clock_unix) {
  // Audit entries are written as ORDINARY FACTS into the same bitemporal
  // store as the data.
  //
  // Not a convenience. It means the audit trail is append-only for the same
  // structural reason the data is, it time-travels with the same scrubber, and
  // "what did this system do, and when did we know it" is answerable by the
  // machinery being demonstrated. The store proving itself on its own audit
  // trail is the point.
  if (next_audit_entity_ == 0) {
    // Allocate above every data entity, lazily. The store's CSR index sizes
    // itself to the largest entity id, so picking a fixed high base (0xF0000000)
    // would force a four-billion-entry allocation the moment anything was
    // logged.
    u32 max_entity = 0;
    for (u32 i = 0; i < static_cast<u32>(store_.fact_count()); ++i) {
      max_entity = std::max(max_entity, store_.fact_entity(FactId{i}).v);
    }
    next_audit_entity_ = max_entity + 1;
  }

  const SymbolId a_query = store_.symbols().intern("audit_query");
  const SymbolId a_purpose = store_.symbols().intern("audit_purpose");
  const SymbolId a_rule = store_.symbols().intern("audit_rule");
  const SymbolId a_allowed = store_.symbols().intern("audit_allowed");
  const SymbolId a_rows = store_.symbols().intern("audit_rows");

  const EntityId e{next_audit_entity_++};
  const Timestamp now = from_unix(wall_clock_unix);

  store_.begin_txn(wall_clock_unix, store_.symbols().intern("audit"));
  store_.assert_fact(e, a_query, Value::symbol(store_.symbols().intern(query)), now,
                     kOpenValid, SourceId{0xFFFF});
  store_.assert_fact(e, a_purpose,
                     Value::symbol(store_.symbols().intern(purpose_name(policy_.purpose()))),
                     now, kOpenValid, SourceId{0xFFFF});
  store_.assert_fact(e, a_rule, Value::symbol(store_.symbols().intern(decision.rule_id)),
                     now, kOpenValid, SourceId{0xFFFF});
  store_.assert_fact(e, a_allowed, Value::boolean(decision.allowed), now, kOpenValid,
                     SourceId{0xFFFF});
  store_.assert_fact(e, a_rows, Value::integer(rows_returned), now, kOpenValid,
                     SourceId{0xFFFF});
  store_.commit_txn();

  ++audit_count_;
}

std::string Session::audit_json(u32 limit) const {
  // Read back OUT of the store rather than from a side list, so what is
  // displayed is what was actually recorded. A side list could drift from the
  // store, and an audit trail that might differ from the record is not one.
  const SymbolId a_query = store_.symbols().find("audit_query");
  if (!a_query.valid()) return "{\"entries\":[]}";

  const SymbolId a_purpose = store_.symbols().find("audit_purpose");
  const SymbolId a_rule = store_.symbols().find("audit_rule");
  const SymbolId a_allowed = store_.symbols().find("audit_allowed");
  const SymbolId a_rows = store_.symbols().find("audit_rows");

  struct Entry {
    std::string query, purpose, rule;
    bool allowed = true;
    i64 rows = 0;
    i64 when = 0;
  };
  std::vector<Entry> entries;

  for (u32 i = 0; i < static_cast<u32>(store_.fact_count()); ++i) {
    const FactId f{i};
    if (store_.fact_attr(f) != a_query) continue;

    Entry e;
    e.when = to_unix(store_.fact_valid_from(f));
    e.query = std::string(store_.symbols().text(store_.fact_value(f).as_symbol()));

    const EntityId owner = store_.fact_entity(f);
    for (u32 j = i; j < static_cast<u32>(store_.fact_count()); ++j) {
      const FactId g{j};
      if (store_.fact_entity(g) != owner) continue;
      const SymbolId attr = store_.fact_attr(g);
      const Value v = store_.fact_value(g);
      if (attr == a_purpose) e.purpose = std::string(store_.symbols().text(v.as_symbol()));
      else if (attr == a_rule) e.rule = std::string(store_.symbols().text(v.as_symbol()));
      else if (attr == a_allowed) e.allowed = v.as_bool();
      else if (attr == a_rows) e.rows = v.as_i64();
    }
    entries.push_back(std::move(e));
  }

  // Newest first, capped.
  std::string s = "{\"entries\":[";
  u32 emitted = 0;
  for (usize k = entries.size(); k-- > 0 && emitted < limit;) {
    const Entry& e = entries[k];
    if (emitted) s += ',';
    s += "{\"query\":";
    json_str(s, e.query);
    s += ",\"purpose\":";
    json_str(s, e.purpose);
    s += ",\"rule\":";
    json_str(s, e.rule);
    s += ",\"allowed\":";
    s += e.allowed ? "true" : "false";
    s += ",\"rows\":" + std::to_string(e.rows);
    s += ",\"when\":" + std::to_string(e.when);
    s += '}';
    ++emitted;
  }
  s += "]}";
  return s;
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

// ── inspect ────────────────────────────────────────────────────────────────

namespace {

/// Renders a Value for display, resolving symbols against the store's table.
void json_value(std::string& out, const Value& v, const SymbolTable& syms) {
  switch (v.kind) {
    case Kind::F64: json_num(out, v.as_f64()); return;
    case Kind::I64: out += std::to_string(v.as_i64()); return;
    case Kind::Bool: out += v.as_bool() ? "true" : "false"; return;
    case Kind::Time: out += std::to_string(to_unix(v.as_time())); return;
    case Kind::Sym: json_str(out, syms.text(v.as_symbol())); return;
    case Kind::Geo: {
      const GeoPoint g = v.as_geo();
      out += "{\"lat\":";
      json_num(out, g.lat());
      out += ",\"lon\":";
      json_num(out, g.lon());
      out += '}';
      return;
    }
    case Kind::Ref: out += std::to_string(v.as_entity().v); return;
    case Kind::Null: out += "null"; return;
  }
  out += "null";
}

/// One fact, as a JSON object. `syms` resolves both the attribute name and any
/// symbol value.
void json_fact(std::string& out, const Store& store, FactId f) {
  const SymbolTable& syms = store.symbols();
  out += "{\"attr\":";
  json_str(out, syms.text(store.fact_attr(f)));
  out += ",\"kind\":" + std::to_string(static_cast<u32>(store.fact_value(f).kind));
  out += ",\"value\":";
  json_value(out, store.fact_value(f), syms);
  out += ",\"source\":" + std::to_string(store.fact_source(f).v);
  out += ",\"validFrom\":" + std::to_string(to_unix(store.fact_valid_from(f)));
  out += ",\"validTo\":" + std::to_string(to_unix(store.fact_valid_to(f)));
  out += ",\"sysFrom\":" + std::to_string(store.fact_sys_from(f));
  out += ",\"sysTo\":" + std::to_string(store.fact_sys_to(f));
  out += '}';
}

/// Parses "12,17,23" into a small set. Empty means "accept any geometry".
std::vector<u32> parse_csv_ids(std::string_view csv) {
  std::vector<u32> out;
  u32 cur = 0;
  bool any = false;
  for (const char c : csv) {
    if (c >= '0' && c <= '9') {
      cur = cur * 10 + static_cast<u32>(c - '0');
      any = true;
    } else if (any) {
      out.push_back(cur);
      cur = 0;
      any = false;
    }
  }
  if (any) out.push_back(cur);
  return out;
}

}  // namespace

std::string Session::inspect_json(f64 lat, f64 lon, f64 radius_m, Timestamp valid_at, u32 sys_at,
                                  std::string_view geo_attrs_csv) const {
  const std::vector<u32> allowed = parse_csv_ids(geo_attrs_csv);

  const auto permitted = [&](SymbolId attr) {
    if (allowed.empty()) return true;
    for (const u32 a : allowed) {
      if (a == attr.v) return true;
    }
    return false;
  };

  // Widen once before giving up. The index returns spatial neighbours, and at a
  // dense location the first k can all be invisible at this (T, S) while a
  // visible one sits just past them.
  FactId hit{0};
  bool found = false;
  f64 best_m = 0.0;

  for (const u32 k : {32u, 256u}) {
    std::vector<u32> candidates;
    geo_.query_knn(lat, lon, k, candidates);

    for (const u32 ref : candidates) {
      const FactId f{ref};
      if (!store_.visible_at(f, valid_at, TxnId{sys_at})) continue;
      if (!permitted(store_.fact_attr(f))) continue;

      const Value v = store_.fact_value(f);
      if (v.kind != Kind::Geo) continue;
      const GeoPoint g = v.as_geo();
      const f64 d = haversine_m(lat, lon, g.lat(), g.lon());
      if (d > radius_m) continue;

      hit = f;
      best_m = d;
      found = true;
      break;
    }
    if (found) break;
  }

  if (!found) return "{\"hit\":false}";

  const EntityId entity = store_.fact_entity(hit);
  const GeoPoint g = store_.fact_value(hit).as_geo();

  std::string s;
  s.reserve(4096);
  s += "{\"hit\":true";
  s += ",\"factId\":" + std::to_string(hit.v);
  s += ",\"entity\":" + std::to_string(entity.v);
  s += ",\"lat\":";
  json_num(s, g.lat());
  s += ",\"lon\":";
  json_num(s, g.lon());
  s += ",\"distanceM\":";
  json_num(s, best_m);
  s += ",\"attr\":";
  json_str(s, store_.symbols().text(store_.fact_attr(hit)));
  s += ",\"source\":" + std::to_string(store_.fact_source(hit).v);

  // What is true right now, at the caller's point on both axes.
  s += ",\"attributes\":[";
  {
    std::vector<FactId> now;
    store_.as_of_entity(entity, valid_at, TxnId{sys_at}, now);
    for (usize i = 0; i < now.size(); ++i) {
      if (i) s += ',';
      json_fact(s, store_, now[i]);
    }
  }
  s += ']';

  // Everything ever said about it. The UI shows only attributes with more than
  // one version, which is where "M4.8 revised to M5.2" comes from — but the
  // filtering is the view's job, because "what changed" is a question about
  // presentation and "what was said" is a question about the store.
  s += ",\"history\":[";
  {
    std::vector<FactId> all;
    store_.all_facts_for_entity(entity, all);
    for (usize i = 0; i < all.size(); ++i) {
      if (i) s += ',';
      json_fact(s, store_, all[i]);
    }
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

Session::QueryOutcome Session::run_query(std::string_view sql, i64 now_unix,
                                         const QueryOptions& opts) {
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
  ctx.has_time_override = opts.has_time_override;
  ctx.valid_at_override = opts.valid_at;
  ctx.sys_at_override = opts.sys_at;

  ql::Plan plan = ql::plan_query(pr.query, ctx);
  if (!plan.ok()) {
    out.error = plan.error.empty() ? "could not plan this query" : plan.error;
    return out;
  }

  // ── policy check ─────────────────────────────────────────────────────────
  //
  // AFTER planning, BEFORE execution. That ordering is the whole design: the
  // rule needs the plan's cardinality estimate to tell "describe a population"
  // from "identify one asset", and a check that ran after execution would
  // already have done the thing it is about to refuse.
  PolicyRequest preq;
  preq.queried_attr = binding->geo_attr;
  preq.estimated_entities = plan.nodes[plan.root].est_rows;
  preq.has_identity_predicate = false;
  preq.has_spatial_bound = pr.query.within.present || pr.query.bbox.present;
  preq.spatial_extent_m = pr.query.within.present ? pr.query.within.distance_m : 0.0;

  // A filter comparing an IDENTIFYING attribute for equality narrows by identity
  // rather than by region — the distinction R1 turns on.
  //
  // The field is resolved through the symbol table and the answer comes from
  // what the source DECLARED, not from the field's spelling. The previous
  // version compared against a hardcoded list of four names that no source in
  // this project uses, so the rule was reachable only by naming a field that
  // does not exist — it could not fire on real data at all.
  if (pr.query.filter_root != ql::kNoNode) {
    for (const ql::Node& n : pr.query.nodes) {
      if (n.kind != ql::NodeKind::Compare) continue;
      if (n.op != ql::CmpOp::Eq) continue;
      const std::string& field = pr.query.str(pr.query.nodes[n.lhs].str);
      const SymbolId attr = store_.symbols().find(field);
      if (attr.valid() && policy_.is_identifying(attr)) {
        preq.has_identity_predicate = true;
      }
    }
  }

  const PolicyDecision decision = policy_.check(preq);
  if (!decision.allowed) {
    out.denied = true;
    out.rule_id = decision.rule_id;
    out.denial_explanation = decision.explanation;
    out.denial_offending = decision.offending;
    out.denial_remedy = decision.remedy;
    out.explain = ql::explain_json(plan);

    // A refused query is still an event worth recording — arguably more so
    // than an allowed one. A refusal is recorded even on a silent re-run: the
    // suppression is for repetition of an ALLOWED question, and losing the fact
    // that something was refused is exactly the gap an audit trail must not have.
    record_audit(sql, decision, 0, now_unix);
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

  // Allowed queries are audited too, with the row count.
  //
  // Recording only refusals is the mistake that makes an audit trail useless:
  // an access log that lists solely the times access was blocked cannot answer
  // "what did this system actually show, and to whom" — which is the question
  // an audit exists for. The first version of this did exactly that, and the
  // test asserting "every query is recorded" is what caught it.
  //
  // Written after the result is packed, so the row count is the real one.
  if (opts.record) record_audit(sql, decision, written, now_unix);
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
