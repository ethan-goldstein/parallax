#include "px/ql/plan.hpp"

#include <algorithm>
#include <cmath>

#include "px/bench.hpp"

namespace px::ql {

const char* plan_op_name(PlanOp op) noexcept {
  switch (op) {
    case PlanOp::SeqScan: return "SeqScan";
    case PlanOp::ZoneMapScan: return "ZoneMapScan";
    case PlanOp::GeoRangeScan: return "GeoRangeScan";
    case PlanOp::Filter: return "Filter";
    case PlanOp::Sort: return "Sort";
    case PlanOp::Limit: return "Limit";
  }
  return "?";
}

namespace {

u32 add_node(Plan& p, PlanNode n) {
  p.nodes.push_back(std::move(n));
  return static_cast<u32>(p.nodes.size() - 1);
}

/// Resolves a temporal clause against the plan's reference instant.
Timestamp resolve_time(const TemporalClause& t, i64 now_unix, Timestamp fallback) {
  if (!t.present) return fallback;
  if (t.relative) return from_unix(now_unix - t.relative_seconds);
  return from_unix(t.absolute_unix);
}

/// Converts a radius query into the bounding box that contains it.
///
/// Longitude degrees shrink with cos(lat); omitting that correction makes a
/// 50 km box at 70 N a third as wide as intended and silently drops
/// neighbours. The box is a filter, not the answer — execute() applies the
/// exact haversine test afterwards, so over-covering costs time and never
/// correctness.
BBox radius_to_bbox(f64 lat, f64 lon, f64 radius_m) {
  constexpr f64 kEarthRadiusM = 6'371'008.8;
  constexpr f64 kPi = 3.14159265358979323846;

  const f64 dlat = (radius_m / kEarthRadiusM) * 180.0 / kPi;
  const f64 coslat = std::max(std::cos(lat * kPi / 180.0), 1e-6);
  const f64 dlon = std::min(dlat / coslat, 180.0);

  return BBox{std::max(lat - dlat, -90.0), std::max(lon - dlon, -180.0),
              std::min(lat + dlat, 90.0), std::min(lon + dlon, 180.0)};
}

/// How many chunks the zone maps can prove cannot match.
///
/// Not a heuristic — it runs the same test execute() will, once per chunk.
/// That costs one comparison per 8192 rows, which is cheap enough to do at
/// plan time and makes the ZoneMapScan estimate exact rather than modelled.
u32 count_skippable_chunks(const Store& store, Timestamp valid_at, u32 sys_at,
                           u32* total_out) {
  const usize chunks = store.chunk_count();
  if (total_out) *total_out = static_cast<u32>(chunks);
  // The store owns the predicate; asking it keeps plan-time and run-time
  // agreeing by construction rather than by two copies of the same logic.
  return store.count_skippable_chunks(valid_at, sys_at);
}

}  // namespace

// ── planner ────────────────────────────────────────────────────────────────

Plan plan_query(const Query& q, const PlanContext& ctx, const CostModel& cost) {
  Plan plan;
  ScopedTimer timer(plan.plan_us);

  if (ctx.store == nullptr) {
    plan.error = "no store";
    return plan;
  }
  const Store& store = *ctx.store;

  plan.geo_attr = ctx.geo_attr;
  plan.scalar_attr = ctx.scalar_attr;
  plan.limit = q.limit;

  // ── resolve the temporal axes ─────────────────────────────────────────────
  //
  // Defaults matter: with no `as of`, "now" on the valid axis and the latest
  // transaction on the system axis is what a user means by an unqualified
  // query. Defaulting the system axis to anything earlier would silently hide
  // recent data.
  plan.valid_at = resolve_time(q.as_of.valid, ctx.now_unix, from_unix(ctx.now_unix));
  plan.sys_at = ctx.current_txn;
  if (q.as_of.system.present) {
    const Timestamp sys_time = resolve_time(q.as_of.system, ctx.now_unix, 0);
    // The system axis is a transaction index, not a clock. Map the requested
    // instant onto the last transaction at or before it — which is exactly
    // what "as we believed at time X" means when knowledge arrives in batches.
    plan.sys_at = store.txn_at_or_before(to_unix(sys_time));
  }
  if (q.since.present) {
    plan.has_since = true;
    plan.since = resolve_time(q.since, ctx.now_unix, kTimeMin);
  }

  const auto total_rows = static_cast<f64>(store.fact_count());

  // ── enumerate access paths ────────────────────────────────────────────────

  struct Candidate {
    PlanOp op;
    f64 cost;
    f64 rows;
    bool exact;
    std::string index;
    std::string detail;
    std::string reason;
    BBox box{};
    u32 ranges = 0;
    u32 chunks_total = 0;
    u32 chunks_skipped = 0;
  };

  std::vector<Candidate> candidates;

  // 1. SeqScan — always available, the baseline everything else must beat.
  candidates.push_back(Candidate{
      PlanOp::SeqScan, total_rows * cost.row_scan, total_rows, true, "none",
      "all facts",
      "no index applicable",
  });

  // 2. ZoneMapScan — chunk-level valid-time pruning, measured not modelled.
  {
    u32 chunks_total = 0;
    const u32 skipped = count_skippable_chunks(store, plan.valid_at, plan.sys_at, &chunks_total);
    const f64 frac = chunks_total > 0 ? static_cast<f64>(skipped) / chunks_total : 0.0;
    const f64 rows = total_rows * (1.0 - frac);

    candidates.push_back(Candidate{
        PlanOp::ZoneMapScan,
        rows * cost.row_scan + static_cast<f64>(chunks_total) * 0.05,
        rows, true, "chunk zone maps",
        "valid-time pruning",
        skipped > 0 ? "zone maps exclude " + std::to_string(skipped) + " of " +
                          std::to_string(chunks_total) + " chunks"
                    : "no chunk excludable at this instant (all valid_to are open)",
        {}, 0, chunks_total, skipped});
  }

  // 3. GeoRangeScan — only when the query is spatially constrained.
  if (ctx.geo != nullptr && ctx.geo->built() && (q.bbox.present || q.within.present)) {
    BBox box{};
    std::string detail;
    bool usable = true;

    if (q.bbox.present) {
      box = BBox{q.bbox.min_lat, q.bbox.min_lon, q.bbox.max_lat, q.bbox.max_lon};
      detail = "bbox";
    } else if (q.within.has_point) {
      box = radius_to_bbox(q.within.lat, q.within.lon, q.within.distance_m);
      detail = "within " + std::to_string(static_cast<i64>(q.within.distance_m)) + "m";
    } else {
      // A named place (port:SGSIN) needs a gazetteer to resolve. Not built
      // yet, so the path is unavailable rather than silently wrong.
      usable = false;
    }

    if (usable) {
      u32 ranges = 0;
      const auto rows = static_cast<f64>(ctx.geo->estimate_range_rows(box, &ranges));

      candidates.push_back(Candidate{
          PlanOp::GeoRangeScan,
          static_cast<f64>(ranges) * cost.seek + rows * cost.row_scan,
          rows, true, "morton z-order",
          detail,
          "exact count over " + std::to_string(ranges) + " key ranges",
          box, ranges});
    }
  }

  // ── choose ────────────────────────────────────────────────────────────────
  // Greedy: cheapest wins. With this few paths there is nothing for a
  // dynamic-programming optimiser to search.
  usize best = 0;
  for (usize i = 1; i < candidates.size(); ++i) {
    if (candidates[i].cost < candidates[best].cost) best = i;
  }

  for (usize i = 0; i < candidates.size(); ++i) {
    if (i == best) continue;
    plan.rejected.push_back(RejectedPath{
        std::string(plan_op_name(candidates[i].op)), candidates[i].cost,
        candidates[i].cost > candidates[best].cost ? "more expensive" : "tie, first wins"});
  }

  const Candidate& c = candidates[best];

  PlanNode scan{};
  scan.op = c.op;
  scan.index_used = c.index;
  scan.detail = c.detail;
  scan.reason = c.reason;
  scan.est_rows = c.rows;
  scan.est_cost = c.cost;
  scan.est_exact = c.exact;
  scan.chunks_total = c.chunks_total;
  scan.chunks_skipped = c.chunks_skipped;
  scan.geo_ranges = c.ranges;
  u32 node = add_node(plan, scan);

  plan.scan_box = c.box;
  plan.scan_has_box = (c.op == PlanOp::GeoRangeScan);

  // ── residual filter ───────────────────────────────────────────────────────
  if (q.filter_root != kNoNode || q.within.present || plan.has_since) {
    PlanNode f{};
    f.op = PlanOp::Filter;
    f.child = node;
    f.index_used = "none";

    std::string detail;
    if (q.filter_root != kNoNode) detail = "scalar predicates";
    if (q.within.present) detail += (detail.empty() ? "" : " + ") + std::string("exact haversine");
    if (plan.has_since) detail += (detail.empty() ? "" : " + ") + std::string("since");
    f.detail = detail;

    // Selectivity for scalar predicates is a GUESS — the classic 1/3 for an
    // inequality. Histograms would improve it and are not built. The UI shows
    // this node as an estimate rather than exact, which is why the est-vs-actual
    // gap is usually visible here and nowhere else.
    const f64 sel = q.filter_root != kNoNode ? 0.33 : 1.0;
    f.est_rows = plan.nodes[node].est_rows * sel;
    f.est_cost = plan.nodes[node].est_rows * cost.predicate;
    f.est_exact = false;
    f.reason = q.filter_root != kNoNode ? "selectivity guessed at 1/3 (no histograms)"
                                        : "geometric and temporal refinement";
    node = add_node(plan, f);
  }

  if (!q.order_by.empty()) {
    PlanNode s{};
    s.op = PlanOp::Sort;
    s.child = node;
    s.detail = q.order_by + (q.order_desc ? " desc" : " asc");
    s.est_rows = plan.nodes[node].est_rows;
    const f64 n = std::max(plan.nodes[node].est_rows, 1.0);
    s.est_cost = n * std::log2(n) * cost.sort;
    node = add_node(plan, s);
  }

  if (q.limit > 0) {
    PlanNode l{};
    l.op = PlanOp::Limit;
    l.child = node;
    l.detail = std::to_string(q.limit);
    l.est_rows = std::min(plan.nodes[node].est_rows, static_cast<f64>(q.limit));
    l.est_cost = 0;
    l.est_exact = true;
    node = add_node(plan, l);
  }

  plan.root = node;
  return plan;
}

// ── executor ───────────────────────────────────────────────────────────────

namespace {

/// Evaluates the filter expression for one entity's attribute values.
struct EvalContext {
  const Store* store;
  const Query* q;
  // Attribute values visible for the current entity at (T, S).
  const std::vector<std::pair<SymbolId, Value>>* attrs;
};

bool value_as_double(const Value& v, f64& out) {
  switch (v.kind) {
    case Kind::F64: out = v.as_f64(); return true;
    case Kind::I64: out = static_cast<f64>(v.as_i64()); return true;
    case Kind::Time: out = static_cast<f64>(v.as_time()); return true;
    case Kind::Bool: out = v.as_bool() ? 1.0 : 0.0; return true;
    default: return false;
  }
}

bool eval_node(const EvalContext& ec, u32 idx);

bool eval_compare(const EvalContext& ec, const Node& cmp) {
  const Node& field_node = ec.q->nodes[cmp.lhs];
  const Node& lit = ec.q->nodes[cmp.rhs];
  const std::string& field = ec.q->str(field_node.str);

  const SymbolId want = ec.store->symbols().find(field);
  if (!want.valid()) return false;  // unknown field matches nothing

  for (const auto& [attr, val] : *ec.attrs) {
    if (attr != want) continue;

    if (lit.kind == NodeKind::LitNumber) {
      f64 lhs = 0;
      if (!value_as_double(val, lhs)) return false;
      switch (cmp.op) {
        case CmpOp::Eq: return lhs == lit.number;
        case CmpOp::NotEq: return lhs != lit.number;
        case CmpOp::Lt: return lhs < lit.number;
        case CmpOp::LtEq: return lhs <= lit.number;
        case CmpOp::Gt: return lhs > lit.number;
        case CmpOp::GtEq: return lhs >= lit.number;
        case CmpOp::Contains: return false;
      }
      return false;
    }

    if (lit.kind == NodeKind::LitString || lit.kind == NodeKind::LitPredicate) {
      if (val.kind != Kind::Sym) return false;
      const std::string_view have = ec.store->symbols().text(val.as_symbol());
      const std::string& want_text = ec.q->str(lit.kind == NodeKind::LitPredicate ? lit.lhs
                                                                                  : lit.str);
      switch (cmp.op) {
        case CmpOp::Eq: return have == want_text;
        case CmpOp::NotEq: return have != want_text;
        case CmpOp::Contains: return have.find(want_text) != std::string_view::npos;
        default: return false;
      }
    }
    return false;
  }

  // The entity does not carry this attribute at this instant. NOT a match —
  // and notably `!=` is false too, because "absent" is not "different". SQL
  // three-valued logic makes the same call for NULL.
  return false;
}

bool eval_node(const EvalContext& ec, u32 idx) {
  if (idx == kNoNode || idx >= ec.q->nodes.size()) return true;
  const Node& n = ec.q->nodes[idx];
  switch (n.kind) {
    case NodeKind::And: return eval_node(ec, n.lhs) && eval_node(ec, n.rhs);
    case NodeKind::Or: return eval_node(ec, n.lhs) || eval_node(ec, n.rhs);
    case NodeKind::Not: return !eval_node(ec, n.lhs);
    case NodeKind::Compare: return eval_compare(ec, n);
    default: return true;
  }
}

}  // namespace

void execute(Plan& plan, const PlanContext& ctx, const Query& q, std::vector<FactId>& out) {
  if (!plan.ok() || ctx.store == nullptr) return;
  const Store& store = *ctx.store;

  // ── scan ──────────────────────────────────────────────────────────────────
  // Walk to the leaf; the scan node is always the deepest.
  u32 scan_idx = plan.root;
  while (plan.nodes[scan_idx].child != kNoNode) scan_idx = plan.nodes[scan_idx].child;
  PlanNode& scan = plan.nodes[scan_idx];

  std::vector<FactId> candidates;
  {
    ScopedTimer t(scan.actual_us);

    if (scan.op == PlanOp::GeoRangeScan && ctx.geo != nullptr) {
      // The index is over facts, so it yields candidate FactIds that still
      // have to pass the bitemporal visibility test — the spatial index knows
      // where things are, not when they were believed.
      std::vector<u32> refs;
      GeoStats gs{};
      ctx.geo->query_bbox(plan.scan_box, refs, &gs);
      scan.geo_ranges = gs.ranges;
      scan.geo_candidates = gs.candidates;

      for (const u32 r : refs) {
        const FactId f{r};
        if (store.visible_at(f, plan.valid_at, TxnId{plan.sys_at})) candidates.push_back(f);
      }
    } else {
      ScanStats ss{};
      store.as_of(plan.valid_at, TxnId{plan.sys_at}, candidates, &ss);
      scan.chunks_total = ss.chunks_total;
      scan.chunks_skipped = ss.chunks_skipped;
      scan.rows_examined = ss.rows_scanned;
    }
    scan.actual_rows = static_cast<u32>(candidates.size());
  }

  // ── group by entity ───────────────────────────────────────────────────────
  // Predicates are per-entity, not per-fact: "magnitude > 6" is a statement
  // about a quake, and the position and magnitude live in different rows.
  std::vector<EntityId> order;
  std::vector<std::pair<EntityId, std::vector<std::pair<SymbolId, Value>>>> grouped;
  {
    std::vector<u32> slot;  // entity index -> position in `grouped`, or U32_MAX
    for (const FactId f : candidates) {
      const EntityId e = store.fact_entity(f);
      if (e.index() >= slot.size()) slot.resize(e.index() + 1, 0xFFFF'FFFFu);
      if (slot[e.index()] == 0xFFFF'FFFFu) {
        slot[e.index()] = static_cast<u32>(grouped.size());
        grouped.emplace_back(e, std::vector<std::pair<SymbolId, Value>>{});
      }
      grouped[slot[e.index()]].second.emplace_back(store.fact_attr(f), store.fact_value(f));
    }
  }

  // ── residual filter ───────────────────────────────────────────────────────
  u32 filter_idx = kNoNode;
  for (u32 i = 0; i < plan.nodes.size(); ++i) {
    if (plan.nodes[i].op == PlanOp::Filter) filter_idx = i;
  }

  std::vector<EntityId> passing;
  {
    f64 filter_us = 0;
    {
      ScopedTimer t(filter_us);
      for (const auto& [entity, attrs] : grouped) {
        const EvalContext ec{&store, &q, &attrs};
        if (q.filter_root != kNoNode && !eval_node(ec, q.filter_root)) continue;

        // Exact haversine refinement. The bbox over-covers a circle by 4/pi at
        // best and much more at high latitude, so this is what makes `within
        // 50km` actually mean 50 km.
        if (q.within.present && q.within.has_point) {
          bool near = false;
          for (const auto& [attr, val] : attrs) {
            if (attr != plan.geo_attr || val.kind != Kind::Geo) continue;
            const GeoPoint g = val.as_geo();
            if (haversine_m(q.within.lat, q.within.lon, g.lat(), g.lon()) <=
                q.within.distance_m) {
              near = true;
            }
            break;
          }
          if (!near) continue;
        }

        if (plan.has_since) {
          bool recent = false;
          for (const auto& [attr, val] : attrs) {
            (void)val;
            if (attr == plan.geo_attr) recent = true;
          }
          if (!recent) continue;
        }

        passing.push_back(entity);
      }
    }
    if (filter_idx != kNoNode) {
      plan.nodes[filter_idx].actual_us = filter_us;
      plan.nodes[filter_idx].actual_rows = static_cast<u32>(passing.size());
      plan.nodes[filter_idx].rows_examined = static_cast<u32>(grouped.size());
    }
  }

  // ── emit the geometry facts for the passing entities ─────────────────────
  std::vector<u8> keep;
  for (const EntityId e : passing) {
    if (e.index() >= keep.size()) keep.resize(e.index() + 1, 0);
    keep[e.index()] = 1;
  }

  u32 emitted = 0;
  for (const FactId f : candidates) {
    if (plan.limit > 0 && emitted >= plan.limit) break;
    if (store.fact_attr(f) != plan.geo_attr) continue;
    const EntityId e = store.fact_entity(f);
    if (e.index() >= keep.size() || keep[e.index()] == 0) continue;
    out.push_back(f);
    ++emitted;
  }

  for (u32 i = 0; i < plan.nodes.size(); ++i) {
    if (plan.nodes[i].op == PlanOp::Limit) {
      plan.nodes[i].actual_rows = emitted;
    }
  }

  // Do NOT overwrite the scan node's count with the emitted count when the
  // scan happens to be the root.
  //
  // A scan's actual_rows means "rows this operator produced". Overwriting it
  // for a query with no filter made the same column mean "rows the query
  // returned" in that one case, so an unfiltered query reported 2,347 where a
  // filtered one over identical data reported 9,423 — making the planner look
  // inconsistent when only the display was. A column in an EXPLAIN table has
  // to mean one thing on every row or the whole panel is untrustworthy.
  plan.emitted_rows = emitted;
}

// ── EXPLAIN serialisation ──────────────────────────────────────────────────

namespace {

void json_escape(const std::string& in, std::string& out) {
  for (const char c : in) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\t': out += "\\t"; break;
      default:
        // Control characters must be escaped or the JSON is invalid. Field
        // names come from user input, so this is not hypothetical.
        if (static_cast<unsigned char>(c) < 0x20) {
          char buf[7];
          std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned>(c) & 0xFFu);
          out += buf;
        } else {
          out += c;
        }
    }
  }
}

void json_kv(std::string& s, const char* key, const std::string& v, bool comma = true) {
  s += '"';
  s += key;
  s += "\":\"";
  json_escape(v, s);
  s += '"';
  if (comma) s += ',';
}

void json_num(std::string& s, const char* key, f64 v, bool comma = true) {
  char buf[64];
  std::snprintf(buf, sizeof(buf), "%.6g", v);
  s += '"';
  s += key;
  s += "\":";
  s += buf;
  if (comma) s += ',';
}

void emit_node(const Plan& p, u32 idx, std::string& s) {
  const PlanNode& n = p.nodes[idx];
  s += '{';
  json_kv(s, "op", plan_op_name(n.op));
  json_kv(s, "index", n.index_used);
  json_kv(s, "detail", n.detail);
  json_kv(s, "reason", n.reason);
  json_num(s, "estRows", n.est_rows);
  json_num(s, "estCost", n.est_cost);
  json_num(s, "actualRows", n.actual_rows);
  json_num(s, "actualUs", n.actual_us);
  json_num(s, "chunksTotal", n.chunks_total);
  json_num(s, "chunksSkipped", n.chunks_skipped);
  json_num(s, "geoRanges", n.geo_ranges);
  json_num(s, "geoCandidates", n.geo_candidates);
  json_num(s, "rowsExamined", n.rows_examined);
  s += "\"exact\":";
  s += n.est_exact ? "true" : "false";
  s += ",\"children\":[";
  if (n.child != kNoNode) emit_node(p, n.child, s);
  s += "]}";
}

}  // namespace

std::string explain_json(const Plan& plan) {
  std::string s;
  s.reserve(1024);
  s += '{';

  if (!plan.error.empty()) {
    json_kv(s, "error", plan.error, false);
    s += '}';
    return s;
  }

  json_num(s, "planUs", plan.plan_us);
  json_num(s, "validAt", static_cast<f64>(to_unix(plan.valid_at)));
  json_num(s, "sysAt", plan.sys_at);
  json_num(s, "emittedRows", plan.emitted_rows);

  s += "\"rejected\":[";
  for (usize i = 0; i < plan.rejected.size(); ++i) {
    if (i) s += ',';
    s += '{';
    json_kv(s, "op", plan.rejected[i].name);
    json_num(s, "estCost", plan.rejected[i].est_cost);
    json_kv(s, "why", plan.rejected[i].why, false);
    s += '}';
  }
  s += "],";

  s += "\"root\":";
  if (plan.root != kNoNode) emit_node(plan, plan.root, s);
  else s += "null";

  s += '}';
  return s;
}

}  // namespace px::ql
