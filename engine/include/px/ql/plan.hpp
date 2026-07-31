// ── px/ql/plan.hpp ──────────────────────────────────────────────────────────
// Physical plans, the cost model, and the EXPLAIN record.
//
// The planner is GREEDY, not Cascades. It enumerates the access paths
// available for the source, picks the cheapest by estimated cost, and applies
// remaining predicates as a residual filter. There is no join reordering
// because there are no joins yet, and no dynamic programming because there is
// nothing to search over.
//
// Saying that plainly matters more than the code does. "Cost-based query
// planner" invites an interviewer to assume Cascades or Volcano; the honest
// description is "greedy access-path selection with measured cardinality
// feedback", and overclaiming here is the fastest way to lose the room.
//
// What IS unusual, and worth the interviewer's attention: two of the four
// estimators are EXACT rather than approximate.
//
//   SysTimeSlice — sys_from is non-decreasing by construction, so a binary
//                  search gives the precise row count, not an estimate.
//   GeoRangeScan — the Morton index is sorted, so counting entries inside the
//                  decomposed key ranges is two binary searches per range.
//                  Exact at cell granularity.
//
// So the EXPLAIN viewer routinely shows est == actual for spatial and
// system-time operators, and wildly off for substring predicates — which is
// precisely what makes an EXPLAIN panel interesting to look at rather than
// decorative.
// ────────────────────────────────────────────────────────────────────────────
#pragma once

#include <string>
#include <vector>

#include "px/geo.hpp"
#include "px/ql/ast.hpp"
#include "px/store.hpp"

namespace px::ql {

enum class PlanOp : u8 {
  SeqScan,       // every fact, no index
  ZoneMapScan,   // chunk-level valid-time pruning
  GeoRangeScan,  // Morton key ranges from a bbox or radius
  Filter,        // residual scalar predicates
  Sort,
  Limit,
};

[[nodiscard]] const char* plan_op_name(PlanOp op) noexcept;

/// One node of the physical plan, carrying both what the planner PREDICTED and
/// what execution actually did. Keeping them in one struct is what makes the
/// estimated-vs-actual comparison in the UI a measurement rather than a claim.
struct PlanNode {
  PlanOp op{};
  u32 child = kNoNode;

  /// Which index was chosen, or "none".
  std::string index_used = "none";
  /// Human-readable detail: the predicate, the box, the limit.
  std::string detail;
  /// Why this path was chosen over the alternatives, in one line.
  std::string reason;

  // ── planner estimates ───────────────────────────────────────────────────
  f64 est_rows = 0;
  f64 est_cost = 0;
  /// True when est_rows is exact rather than approximate. Surfaced in the UI,
  /// because "I know" and "I guessed" are different claims.
  bool est_exact = false;

  // ── execution actuals ───────────────────────────────────────────────────
  u32 actual_rows = 0;
  f64 actual_us = 0;

  // ── per-operator counters ───────────────────────────────────────────────
  u32 chunks_total = 0;
  u32 chunks_skipped = 0;
  u32 geo_ranges = 0;
  u32 geo_candidates = 0;
  u32 rows_examined = 0;
};

/// An access path the planner considered but did not choose. Reporting the
/// rejected alternatives with their costs is what turns EXPLAIN from an
/// assertion into an argument.
struct RejectedPath {
  std::string name;
  f64 est_cost = 0;
  std::string why;
};

struct Plan {
  std::vector<PlanNode> nodes;
  u32 root = kNoNode;
  std::vector<RejectedPath> rejected;

  // Resolved query parameters. Relative times in the AST are turned into
  // absolute instants HERE, at plan time, against a caller-supplied `now` —
  // so the engine has no hidden clock dependency and a test can pin it.
  Timestamp valid_at = 0;
  u32 sys_at = 0;
  Timestamp since = kTimeMin;
  bool has_since = false;

  SymbolId geo_attr{};
  SymbolId scalar_attr{};
  u32 limit = 0;

  /// The box the GeoRangeScan will probe, resolved at plan time. Carried on
  /// the plan rather than recomputed in the executor so that EXPLAIN describes
  /// exactly what ran.
  BBox scan_box{};
  bool scan_has_box = false;

  /// Rows the query actually returned, after filtering and limiting. Kept
  /// separate from any node's actual_rows so that column keeps one meaning.
  u32 emitted_rows = 0;

  f64 plan_us = 0;
  std::string error;

  [[nodiscard]] bool ok() const noexcept { return error.empty() && root != kNoNode; }
};

/// Everything the planner needs that is not in the query text.
struct PlanContext {
  const Store* store = nullptr;
  const GeoIndex* geo = nullptr;

  /// Reference instant for relative times, as unix seconds. Injected rather
  /// than read from a clock so plans are reproducible and testable.
  i64 now_unix = 0;

  /// Which attribute carries geometry for the queried source, and which
  /// carries the scalar the renderer maps to size and colour.
  SymbolId geo_attr{};
  SymbolId scalar_attr{};

  /// Latest transaction, used when the query does not pin a system time.
  u32 current_txn = 0;

  /// Pins the temporal axes, overriding both the defaults and the query's own
  /// `as of` clause.
  ///
  /// This exists because the scrubber, not the query text, is the authority on
  /// where the session is in time. Re-running a query at a new instant by
  /// rewriting its SQL would mean round-tripping the system axis through a wall
  /// clock — and the system axis is a transaction INDEX, not a clock. Several
  /// transactions routinely share a wall-clock second (the live feeds all land
  /// in the same minute bucket), so `txn_at_or_before` would resolve back to the
  /// last of those, not the one the user selected. Passing the index directly is
  /// the only way for the two axes to mean exactly what the scrubber shows.
  ///
  /// Applied before access-path selection so the plan's cardinality estimates
  /// describe the instant actually executed — otherwise EXPLAIN would compare an
  /// estimate for one moment against an actual for another.
  bool has_time_override = false;
  Timestamp valid_at_override = 0;
  u32 sys_at_override = 0;
};

/// Cost model constants, in arbitrary units calibrated so a sequential row
/// scan is 1.0. They only need to be right RELATIVE to each other — the
/// planner compares costs, it never reports them as time.
struct CostModel {
  f64 row_scan = 1.0;
  /// A binary search or range seek. ~30x a row because it is a cache miss
  /// chain rather than a linear walk.
  f64 seek = 30.0;
  /// Evaluating one residual predicate on one row.
  f64 predicate = 0.4;
  /// Sorting is n log n; this is the per-comparison constant.
  f64 sort = 1.2;
};

[[nodiscard]] Plan plan_query(const Query& q, const PlanContext& ctx,
                              const CostModel& cost = {});

/// Runs the plan, filling in the actual_* fields on every node.
/// Appends matching FactIds for the geometry attribute to `out`.
void execute(Plan& plan, const PlanContext& ctx, const Query& q,
             std::vector<FactId>& out);

/// Serialises the plan as JSON for the EXPLAIN viewer.
///
/// JSON over embind is the right call here specifically because an EXPLAIN
/// record is small (a few KB) and human-readable. The same choice would be
/// wrong for the point buffer, which is why that path uses raw memory instead.
[[nodiscard]] std::string explain_json(const Plan& plan);

}  // namespace px::ql
