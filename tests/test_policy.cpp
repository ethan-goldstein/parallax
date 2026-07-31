#include <string>

#include <doctest.h>

#include "px/policy.hpp"
#include "px/session.hpp"

using namespace px;

namespace {

/// A session with one vessel-like source, typed Precise.
struct World {
  Session session;
  SymbolId position, speed;

  World() {
    position = session.intern("vessel_position");
    speed = session.intern("speed");
    session.register_source("vessels", position, speed);

    // A vessel's position locates a specific asset, so it is Precise rather
    // than Public. Threading sensitivity through the ontology is what lets a
    // rule reason about it at all.
    session.set_sensitivity(position, Sensitivity::Precise);

    ingest_vessels();
  }

  void ingest_vessels() {
    // 40 vessels clustered around Helsinki, plus one isolated far away.
    std::vector<wire::Fact> batch;
    for (u32 i = 0; i < 40; ++i) {
      const Value v = Value::geo(GeoPoint::from_degrees(60.0 + i * 0.01, 24.9 + i * 0.01));
      batch.push_back(wire::Fact{v.bits, i, position.v, 0, kOpenValid, 1,
                                 static_cast<u8>(v.kind), 0});
    }
    const Value lone = Value::geo(GeoPoint::from_degrees(-40.0, -70.0));
    batch.push_back(
        wire::Fact{lone.bits, 999, position.v, 0, kOpenValid, 1, static_cast<u8>(lone.kind), 0});

    const u32 bytes = static_cast<u32>(batch.size() * sizeof(wire::Fact));
    std::memcpy(session.staging_buffer(bytes), batch.data(), bytes);
    session.ingest(0, bytes, 1'785'000'000);
    session.finish_ingest();
  }

  Session::QueryOutcome run(std::string_view sql) {
    return session.run_query(sql, 1'785'000'100);
  }
};

}  // namespace

// ── the engine in isolation ────────────────────────────────────────────────

TEST_CASE("purposes parse, and unknown ones are rejected") {
  Purpose p{};
  CHECK(parse_purpose("demonstration", p));
  CHECK(p == Purpose::Demonstration);
  CHECK(parse_purpose("maritime-safety", p));
  CHECK(p == Purpose::MaritimeSafety);
  CHECK_FALSE(parse_purpose("whatever-i-want", p));
}

TEST_CASE("person-linked data is refused under every purpose") {
  PolicyEngine e;
  const SymbolId attr{7};
  e.set_sensitivity(attr, Sensitivity::PersonLinked);

  PolicyRequest req;
  req.queried_attr = attr;
  req.estimated_entities = 10'000;  // wide, so R1 cannot be what fires

  for (const Purpose p : {Purpose::Demonstration, Purpose::MaritimeSafety,
                          Purpose::DisasterResponse}) {
    e.set_purpose(p);
    const PolicyDecision d = e.check(req);
    INFO("purpose=", purpose_name(p));
    CHECK_FALSE(d.allowed);
    CHECK(d.rule_id == "R0-person-linked");
  }
}

TEST_CASE("public attributes are never restricted by R1") {
  PolicyEngine e;
  const SymbolId attr{7};  // unregistered, so Public by default

  PolicyRequest req;
  req.queried_attr = attr;
  req.estimated_entities = 1;  // as narrow as it gets
  req.has_identity_predicate = true;

  // Earthquakes are public information. Narrowing to one is not a privacy
  // event, and a policy engine that refused it would be theatre.
  CHECK(e.check(req).allowed);
}

// ── the rule that does the work ────────────────────────────────────────────

TEST_CASE("R1 refuses narrowing to an individual asset under demonstration") {
  PolicyEngine e;
  const SymbolId attr{7};
  e.set_sensitivity(attr, Sensitivity::Precise);
  e.set_purpose(Purpose::Demonstration);

  PolicyRequest req;
  req.queried_attr = attr;
  req.estimated_entities = 2;  // below k = 5

  const PolicyDecision d = e.check(req);
  CHECK_FALSE(d.allowed);
  CHECK(d.rule_id == "R1-individual-narrowing");
  // A denial has to explain itself and say what would fix it, or it is just a
  // wall.
  CHECK(!d.explanation.empty());
  CHECK(!d.remedy.empty());
  CHECK(d.offending.find("below k") != std::string::npos);
}

TEST_CASE("R1 permits the same query under a purpose that needs it") {
  PolicyEngine e;
  const SymbolId attr{7};
  e.set_sensitivity(attr, Sensitivity::Precise);

  PolicyRequest req;
  req.queried_attr = attr;
  req.estimated_entities = 2;

  // The SAME query, allowed or refused purely by declared purpose. That is
  // purpose limitation working — a collision warning is about one vessel, so
  // refusing identification would refuse the work.
  e.set_purpose(Purpose::Demonstration);
  CHECK_FALSE(e.check(req).allowed);

  e.set_purpose(Purpose::MaritimeSafety);
  CHECK(e.check(req).allowed);
}

TEST_CASE("R1 catches a tight radius even when the estimate is wide") {
  PolicyEngine e;
  const SymbolId attr{7};
  e.set_sensitivity(attr, Sensitivity::Precise);
  e.set_purpose(Purpose::Demonstration);

  PolicyRequest req;
  req.queried_attr = attr;
  req.estimated_entities = 1000;  // cardinality alone would allow it
  req.has_spatial_bound = true;
  req.spatial_extent_m = 50.0;

  // A 50 m radius is following one vessel regardless of what the estimate
  // says, so extent is checked independently of cardinality.
  const PolicyDecision d = e.check(req);
  CHECK_FALSE(d.allowed);
  CHECK(d.offending.find("radius") != std::string::npos);
}

TEST_CASE("R1 catches selection by identifier") {
  PolicyEngine e;
  const SymbolId attr{7};
  e.set_sensitivity(attr, Sensitivity::Precise);
  e.set_purpose(Purpose::Demonstration);

  PolicyRequest req;
  req.queried_attr = attr;
  req.estimated_entities = 1000;
  req.has_identity_predicate = true;

  CHECK_FALSE(e.check(req).allowed);
}

TEST_CASE("a wide population query is allowed") {
  PolicyEngine e;
  const SymbolId attr{7};
  e.set_sensitivity(attr, Sensitivity::Precise);
  e.set_purpose(Purpose::Demonstration);

  PolicyRequest req;
  req.queried_attr = attr;
  req.estimated_entities = 500;
  req.has_spatial_bound = true;
  req.spatial_extent_m = 40'000;

  // "Vessels within 40 km of Helsinki" is traffic analysis, not surveillance.
  CHECK(e.check(req).allowed);
}

// ── end to end, through the query path ─────────────────────────────────────

TEST_CASE("a wide query runs; a 50 m query is denied as a first-class result") {
  World w;

  const Session::QueryOutcome wide = w.run("vessels within 40km of (60.2, 25.1)");
  INFO("wide error=", wide.error, " denied=", wide.denied);
  CHECK(wide.ok);
  CHECK_FALSE(wide.denied);

  const Session::QueryOutcome narrow = w.run("vessels within 50m of (60.0, 24.9)");
  CHECK_FALSE(narrow.ok);
  CHECK(narrow.denied);
  CHECK(narrow.rule_id == "R1-individual-narrowing");
  // A denial is NOT a parse error. Conflating them would tell the user they
  // typed something wrong when they typed something they are not authorised
  // to ask.
  CHECK(narrow.error.empty());
  CHECK(!narrow.denial_remedy.empty());
}

TEST_CASE("declaring a purpose changes what the same query returns") {
  World w;
  const char* sql = "vessels within 50m of (60.0, 24.9)";

  CHECK(w.run(sql).denied);

  REQUIRE(w.session.set_purpose("maritime-safety"));
  const Session::QueryOutcome after = w.run(sql);
  INFO("error=", after.error);
  CHECK_FALSE(after.denied);
}

TEST_CASE("unknown purposes are refused rather than silently accepted") {
  World w;
  CHECK_FALSE(w.session.set_purpose("unrestricted"));
  // The purpose must be unchanged, not reset to something permissive.
  CHECK(w.session.purpose() == Purpose::Demonstration);
}

// ── the audit trail ────────────────────────────────────────────────────────

TEST_CASE("every query is recorded, including the refused ones") {
  World w;
  w.run("vessels within 40km of (60.2, 25.1)");
  w.run("vessels within 50m of (60.0, 24.9)");  // denied

  const std::string audit = w.session.audit_json();
  INFO(audit);

  // A refused query is arguably MORE worth recording than an allowed one.
  CHECK(audit.find("R1-individual-narrowing") != std::string::npos);
  CHECK(audit.find("\"allowed\":false") != std::string::npos);
  CHECK(audit.find("demonstration") != std::string::npos);
}

TEST_CASE("the audit trail lives in the bitemporal store itself") {
  World w;
  const usize before = w.session.store().fact_count();
  const u32 txns_before = static_cast<u32>(w.session.store().transactions().size());

  w.run("vessels within 40km of (60.2, 25.1)");

  // Audit entries are ordinary facts in ordinary transactions — which is what
  // makes the trail append-only for the same structural reason the data is,
  // and scrubbable with the same control.
  CHECK(w.session.store().fact_count() > before);
  CHECK(w.session.store().transactions().size() > txns_before);
}

TEST_CASE("audit entities do not collide with data entities") {
  World w;
  w.run("vessels within 40km of (60.2, 25.1)");

  // Audit ids are allocated above every data entity. A collision would attach
  // audit attributes to a real vessel — corrupting the data with the record of
  // having looked at it.
  const std::string audit = w.session.audit_json();
  CHECK(audit.find("\"entries\":[]") == std::string::npos);

  // And the vessels must still be intact and queryable.
  const Session::QueryOutcome after = w.run("vessels within 40km of (60.2, 25.1)");
  CHECK(after.ok);
  CHECK(after.batch.count > 0);
}

TEST_CASE("audit_json is well-formed even with no entries") {
  Session s;
  const std::string audit = s.audit_json();
  CHECK(audit.front() == '{');
  CHECK(audit.back() == '}');
  CHECK(audit.find("entries") != std::string::npos);
}
