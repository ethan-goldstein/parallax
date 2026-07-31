#include "px/policy.hpp"

#include <cstdio>

namespace px {

const char* sensitivity_name(Sensitivity s) noexcept {
  switch (s) {
    case Sensitivity::Public: return "public";
    case Sensitivity::Precise: return "precise";
    case Sensitivity::PersonLinked: return "person-linked";
  }
  return "?";
}

const char* purpose_name(Purpose p) noexcept {
  switch (p) {
    case Purpose::Demonstration: return "demonstration";
    case Purpose::MaritimeSafety: return "maritime safety";
    case Purpose::DisasterResponse: return "disaster response";
  }
  return "?";
}

bool parse_purpose(std::string_view s, Purpose& out) noexcept {
  if (s == "demonstration") { out = Purpose::Demonstration; return true; }
  if (s == "maritime-safety") { out = Purpose::MaritimeSafety; return true; }
  if (s == "disaster-response") { out = Purpose::DisasterResponse; return true; }
  return false;
}

void PolicyEngine::set_sensitivity(SymbolId attr, Sensitivity s) {
  for (AttributePolicy& a : attrs_) {
    if (a.attr == attr) {
      a.sensitivity = s;
      return;
    }
  }
  attrs_.push_back(AttributePolicy{attr, s});
}

void PolicyEngine::set_identifying(SymbolId attr, bool identifying) {
  for (AttributePolicy& a : attrs_) {
    if (a.attr == attr) {
      a.identifying = identifying;
      return;
    }
  }
  attrs_.push_back(AttributePolicy{attr, Sensitivity::Public, identifying});
}

bool PolicyEngine::is_identifying(SymbolId attr) const noexcept {
  for (const AttributePolicy& a : attrs_) {
    if (a.attr == attr) return a.identifying;
  }
  // Undeclared attributes do not identify. Fail-open here is safe for the same
  // narrow reason it is for sensitivity — see the note below — and unlike
  // sensitivity, a false negative costs a refusal rather than a disclosure.
  return false;
}

Sensitivity PolicyEngine::sensitivity_of(SymbolId attr) const noexcept {
  for (const AttributePolicy& a : attrs_) {
    if (a.attr == attr) return a.sensitivity;
  }
  // Unregistered attributes default to Public.
  //
  // Fail-open is the wrong instinct for a policy engine, and it is deliberate
  // here for one narrow reason: this project collects nothing person-linked,
  // so the safe default is the accurate one. In a system that did hold such
  // data the default must invert — an unclassified attribute would be the most
  // restricted, not the least. Stated because the difference matters more than
  // the code does.
  return Sensitivity::Public;
}

bool PolicyEngine::purpose_permits_identification() const noexcept {
  switch (purpose_) {
    case Purpose::Demonstration:
      return false;
    case Purpose::MaritimeSafety:
    case Purpose::DisasterResponse:
      // These purposes exist precisely to act on individual assets — a
      // collision warning is about one vessel, an evacuation is about one
      // area. Refusing identification would refuse the work.
      return true;
  }
  return false;
}

PolicyDecision PolicyEngine::check(const PolicyRequest& req) const {
  PolicyDecision d;
  const Sensitivity sens = sensitivity_of(req.queried_attr);

  // ── R0: person-linked data is never queryable ────────────────────────────
  //
  // Unconditional, and not overridable by any purpose. PARALLAX does not
  // ingest person-linked attributes at all, so this rule should never fire —
  // it exists so that if one were ever added, the default is refusal rather
  // than a silent new capability.
  if (sens == Sensitivity::PersonLinked) {
    d.allowed = false;
    d.rule_id = "R0-person-linked";
    d.explanation =
        "This attribute is typed as linkable to a natural person. PARALLAX "
        "does not serve person-linked data under any purpose.";
    d.offending = "attribute sensitivity: person-linked";
    d.remedy = "No purpose grants this. The data should not be here.";
    return d;
  }

  // ── R1: individual narrowing ─────────────────────────────────────────────
  //
  // The rule that does the real work. A Precise attribute queried so narrowly
  // that it returns fewer than k entities is identifying a specific asset, not
  // describing a population — and that requires a purpose that says so.
  //
  // Evaluated against the PLAN's estimate, before any row is read: a check
  // that needed the result set would already have done the thing it is about
  // to refuse.
  if (sens >= Sensitivity::Precise && !purpose_permits_identification()) {
    const bool narrow_by_count =
        req.estimated_entities > 0 && req.estimated_entities < PolicyEngine::kMinEntities;
    // A very tight radius narrows to an individual even when the estimate is
    // unreliable, so extent is checked independently of cardinality.
    const bool narrow_by_extent = req.has_spatial_bound && req.spatial_extent_m > 0 &&
                                  req.spatial_extent_m < 500.0;

    if (narrow_by_count || req.has_identity_predicate || narrow_by_extent) {
      char buf[256];
      if (req.has_identity_predicate) {
        std::snprintf(buf, sizeof(buf),
                      "the query selects by identifier rather than by region");
      } else if (narrow_by_extent) {
        std::snprintf(buf, sizeof(buf), "the search radius is %.0f m",
                      req.spatial_extent_m);
      } else {
        std::snprintf(buf, sizeof(buf), "the plan estimates %.0f entities, below k=%u",
                      req.estimated_entities, PolicyEngine::kMinEntities);
      }

      d.allowed = false;
      d.rule_id = "R1-individual-narrowing";
      d.explanation =
          "This query narrows to an individual asset rather than describing a "
          "population, and the declared purpose does not permit identifying "
          "individuals. The engine can compute this; it is not authorised to.";
      d.offending = buf;
      d.remedy =
          "Widen the query so it returns at least 5 entities, or declare a "
          "purpose that permits identification (maritime safety, disaster "
          "response).";
      return d;
    }
  }

  d.rule_id = "allowed";
  return d;
}

}  // namespace px
