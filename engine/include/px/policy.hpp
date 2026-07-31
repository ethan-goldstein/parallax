// ── px/policy.hpp ───────────────────────────────────────────────────────────
// Purpose limitation, sensitivity typing, and the audit log.
//
// This is the part of the system that says no.
//
// ── why it exists ──────────────────────────────────────────────────────────
//
// Every capability in this engine is dual-use. A spatial index that answers
// "which vessels are near this port" answers "where is this specific vessel"
// with the same code path and the same cost. The difference is not technical;
// it is a question about intent, and a system that cannot represent intent
// cannot distinguish the two.
//
// So intent is represented: a session declares a PURPOSE, attributes carry a
// SENSITIVITY, and rules are evaluated against the query PLAN — after
// cardinality is known but before any row is read. A denial is a first-class
// result carrying a rule id and a plain-English explanation, not an error.
//
// ── the rule that matters ──────────────────────────────────────────────────
//
// R1, individual narrowing: a query over a Precise-or-higher attribute whose
// plan estimates it will return fewer than k entities is refused unless the
// declared purpose permits identifying individuals.
//
// That is k-anonymity applied at plan time, and it is the difference between
// a capability and a permission. "Vessels within 40 km of Helsinki" is traffic
// analysis. "Vessels within 50 m of this point" is following one ship. The
// engine can compute both; only one of them is authorised under a
// demonstration purpose, and the plan's own cardinality estimate is what tells
// them apart.
//
// ── the audit log ──────────────────────────────────────────────────────────
//
// Every decision is written into the bitemporal store as ordinary facts. That
// is not a convenience — it means the audit trail is append-only for the same
// structural reason the data is, it can be time-travelled with the same
// scrubber, and "what did this system do, and when did we know it" is
// answerable by the machinery already being demonstrated. The store proving
// itself on its own audit trail is the point.
// ────────────────────────────────────────────────────────────────────────────
#pragma once

#include <string>
#include <string_view>
#include <vector>

#include "px/ids.hpp"
#include "px/prelude.hpp"

namespace px {

/// How identifying an attribute is. Ordered — comparisons are meaningful.
enum class Sensitivity : u8 {
  /// Aggregate or naturally public: seismic events, weather.
  Public = 0,
  /// Precise enough to locate a specific asset: an individual vessel's
  /// position, an aircraft's track.
  Precise = 1,
  /// Linkable to a natural person. Nothing in PARALLAX is currently typed
  /// this way, and the README says so — the level exists because the type
  /// system should be able to express the category it refuses to collect.
  PersonLinked = 2,
};

[[nodiscard]] const char* sensitivity_name(Sensitivity s) noexcept;

/// Why this session is querying. Declared up front, not inferred.
enum class Purpose : u8 {
  /// The public demo. Deliberately the most restricted: a visitor who has
  /// declared nothing gets the least.
  Demonstration = 0,
  /// Vessel traffic and collision-risk analysis. Permits narrowing to
  /// individual vessels, because that is what the work requires.
  MaritimeSafety = 1,
  /// Post-event response. Permits precise location for hazards.
  DisasterResponse = 2,
};

[[nodiscard]] const char* purpose_name(Purpose p) noexcept;
[[nodiscard]] bool parse_purpose(std::string_view s, Purpose& out) noexcept;

/// The outcome of a policy check. A denial is a RESULT, not an exception —
/// it carries everything needed to explain itself to the person refused.
struct PolicyDecision {
  bool allowed = true;
  /// Stable identifier, e.g. "R1-individual-narrowing". Stable so a denial can
  /// be cited, appealed, and found in the audit log later.
  std::string rule_id;
  /// Plain English, addressed to the user rather than to a log.
  std::string explanation;
  /// What specifically triggered it.
  std::string offending;
  /// What would make this query permissible, when anything would.
  std::string remedy;
};

struct AttributePolicy {
  SymbolId attr{};
  Sensitivity sensitivity = Sensitivity::Public;
};

/// Inputs a rule can see. Deliberately the PLAN's properties rather than the
/// result set: a check that had to read rows first would already have done the
/// thing it might be about to refuse.
struct PolicyRequest {
  SymbolId queried_attr{};
  /// The planner's estimate for how many entities this returns.
  f64 estimated_entities = 0;
  /// Whether the query narrows by identity rather than by region.
  bool has_identity_predicate = false;
  /// Whether the query is spatially bounded, and how tightly.
  bool has_spatial_bound = false;
  f64 spatial_extent_m = 0;
};

class PolicyEngine {
 public:
  /// Below this many entities, a Precise query counts as identifying an
  /// individual asset rather than describing a population.
  ///
  /// 5 is a judgement call, not a standard. Real k-anonymity work picks k from
  /// the data and the threat model; this is a demonstration of the MECHANISM,
  /// and pretending otherwise would be the kind of overclaim the rest of this
  /// project avoids.
  static constexpr u32 kMinEntities = 5;

  void set_purpose(Purpose p) noexcept { purpose_ = p; }
  [[nodiscard]] Purpose purpose() const noexcept { return purpose_; }

  void set_sensitivity(SymbolId attr, Sensitivity s);
  [[nodiscard]] Sensitivity sensitivity_of(SymbolId attr) const noexcept;

  /// Evaluates every rule. Returns the FIRST denial, so the explanation names
  /// one concrete reason rather than a list the user has to triage.
  [[nodiscard]] PolicyDecision check(const PolicyRequest& req) const;

  /// True when the declared purpose permits narrowing to individual assets.
  [[nodiscard]] bool purpose_permits_identification() const noexcept;

 private:
  Purpose purpose_ = Purpose::Demonstration;
  std::vector<AttributePolicy> attrs_;
};

/// One entry in the audit trail.
struct AuditEntry {
  u32 id = 0;
  std::string query;
  std::string purpose;
  bool allowed = true;
  std::string rule_id;
  u32 rows_returned = 0;
  i64 wall_clock_unix = 0;
  /// Transaction this decision was recorded in — its position on the system
  /// axis, so the audit trail is scrubbable like everything else.
  u32 txn = 0;
};

}  // namespace px
