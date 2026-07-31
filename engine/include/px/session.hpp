// ── px/session.hpp ──────────────────────────────────────────────────────────
// Everything one browser tab owns: the store, the buffers that cross the
// boundary, and the generation counter that keeps them safe.
//
// This lives in engine/ rather than in bindings/wasm/ on purpose. The buffer
// lifecycle — allocate once at capacity, never grow mid-frame, bump the
// generation on realloc — is the part most likely to have a subtle bug, and
// putting it here means the native test suite exercises it under ASan. If it
// lived in the emscripten binding it could only ever be tested in a browser,
// which is the worst place to debug memory.
// ────────────────────────────────────────────────────────────────────────────
#pragma once

#include <string>
#include <string_view>
#include <vector>

#include "px/prelude.hpp"
#include "px/er.hpp"
#include "px/geo.hpp"
#include "px/policy.hpp"
#include "px/ql/plan.hpp"
#include "px/store.hpp"
#include "px/wire.hpp"

namespace px {

/// Result of an ingest batch. Counts rather than a Status because a batch is
/// expected to contain some unusable records — a feed that drops a coordinate
/// on one vessel should not fail the other 4,999.
struct IngestResult {
  u32 accepted = 0;
  u32 rejected = 0;
  TxnId txn{};
};

class Session {
 public:
  /// `max_points` fixes the render buffer capacity for the lifetime of the
  /// session. Fixed capacity is the whole safety argument: a buffer that never
  /// reallocates can never move under a typed-array view that JavaScript is
  /// holding across a call.
  explicit Session(u32 max_points = 262'144);

  // ── ingest ───────────────────────────────────────────────────────────────
  //
  // NOTE ON THE ADDRESS TYPE, because it is not a detail.
  //
  // The engine deals in real pointers and in offsets. It never deals in u32
  // addresses. Under wasm32 a pointer happens to fit in a u32, but natively it
  // does not, and an engine API typed `u32 ptr` truncates every native pointer
  // to its low half — producing an address that is wrong in a way no test can
  // survive and no bounds check can catch, because the check is comparing
  // truncated values too.
  //
  // So: the boundary between "engine" and "32-bit heap address" lives in
  // bindings/wasm/px_wasm.cpp, which is the only place that knows it is
  // running in a browser. Everything here stays correct on both targets, which
  // is what lets the native test suite exercise this code under ASan at all.

  /// Grows the staging buffer to at least `bytes` and returns a pointer to it.
  ///
  /// This is the one buffer allowed to reallocate, because JS re-reads the
  /// address immediately before writing into it and never holds it across an
  /// engine call. The generation still bumps, so a stale view is detectable.
  u8* staging_buffer(u32 bytes);

  [[nodiscard]] u32 staging_capacity() const noexcept {
    return static_cast<u32>(staging_.size());
  }

  /// Interprets `[byte_offset, byte_offset + byte_len)` WITHIN the staging
  /// buffer as an array of wire::Fact and appends them in one transaction.
  ///
  /// An offset, not an address: the range is then trivially checkable against
  /// a size we own, on any target, with no pointer arithmetic that could
  /// overflow or wrap.
  ///
  /// Contents are written by JavaScript and are untrusted by definition. A bad
  /// length or a garbage Kind tag must produce a rejected count, never a read
  /// outside the buffer.
  IngestResult ingest(u32 byte_offset, u32 byte_len, i64 wall_clock_unix);

  // ── query ────────────────────────────────────────────────────────────────

  /// Result of a point query. Carries a real pointer; the wasm binding narrows
  /// it to a heap offset for the wire::BufferRef that crosses to JavaScript.
  struct PointBatch {
    const wire::Point* data = nullptr;
    u32 count = 0;
    u32 generation = 0;
    u32 truncated = 0;
  };

  /// Runs the bitemporal slice and packs the matching facts as wire::Point.
  ///
  /// Only facts whose value is a GeoPoint become points, so a store holding
  /// mixed attributes renders correctly without the caller pre-filtering.
  PointBatch query_points(Timestamp valid_at, u32 sys_at, SymbolId geo_attr,
                          SymbolId scalar_attr);

  // ── query language ───────────────────────────────────────────────────────

  /// Binds a source name in the query language to the attributes that carry
  /// its geometry and its scalar. `earthquakes` and `vessels` are different
  /// sources precisely because they answer to different attributes.
  void register_source(std::string_view name, SymbolId geo_attr, SymbolId scalar_attr);

  struct QueryOutcome {
    PointBatch batch;
    bool ok = false;
    /// Parse or plan failure, with the byte span so the UI can underline it.
    std::string error;
    u32 error_begin = 0;
    u32 error_end = 0;
    /// The EXPLAIN record as JSON. Small and human-readable, which is exactly
    /// when JSON across the boundary is the right choice.
    std::string explain;

    /// A policy refusal is a RESULT, not an error. It is reported separately
    /// from `error` because "you typed something invalid" and "you asked
    /// something you are not authorised to ask" are different answers and the
    /// UI must not conflate them.
    bool denied = false;
    std::string rule_id;
    std::string denial_explanation;
    std::string denial_offending;
    std::string denial_remedy;
  };

  /// Parses, plans, executes, and packs the result for rendering.
  QueryOutcome run_query(std::string_view sql, i64 now_unix);

  // ── policy and audit ─────────────────────────────────────────────────────

  /// Declares why this session is querying. Every subsequent query is checked
  /// against it and recorded with it.
  bool set_purpose(std::string_view purpose_name);
  [[nodiscard]] Purpose purpose() const noexcept { return policy_.purpose(); }

  /// Types an attribute's sensitivity. Threaded through the ontology from the
  /// start rather than bolted on, which is the difference between "the type
  /// system carries sensitivity" and "I added a check".
  void set_sensitivity(SymbolId attr, Sensitivity s) { policy_.set_sensitivity(attr, s); }

  /// The audit trail, as JSON. Read back OUT of the bitemporal store, not from
  /// a side list — so what is displayed is what was actually recorded.
  [[nodiscard]] std::string audit_json(u32 limit = 50) const;

  /// Appends one decision to the audit trail, as facts in the store.
  void record_audit(std::string_view query, const PolicyDecision& decision,
                    u32 rows_returned, i64 wall_clock_unix);

  /// Rebuilds every index after a run of ingest() calls.
  ///
  /// Call ONCE after the last batch, never per batch. Both index rebuilds are
  /// O(n) over the whole store, so doing them per batch is quadratic in the
  /// batch count — which measured 9.7 s across 2,841 transactions before this
  /// was split out.
  void finish_ingest();

  /// Rebuilds the spatial index over every geo-valued fact. Called after a
  /// bulk ingest; queries fall back to a scan while it is stale, so a
  /// forgotten rebuild is a performance bug rather than a wrong answer.
  void rebuild_geo_index();

  // ── entity resolution ────────────────────────────────────────────────────

  /// Runs resolution over every entity carrying `geo_attr`, at the latest
  /// (valid, system) point.
  ///
  /// Records are built from the store rather than from the feed clients, so
  /// resolution operates on what was actually ingested — including its
  /// provenance — rather than on a parallel copy that could drift.
  er::ErStats resolve_entities(SymbolId geo_attr, SymbolId scalar_attr);

  /// Merge evidence for the clusters that actually merged, as JSON.
  /// `limit` caps how many clusters are described.
  [[nodiscard]] std::string merge_evidence_json(u32 limit = 25) const;

  /// Identifies the nearest visible point to a click and answers everything
  /// knowable about it, as JSON.
  ///
  /// Picking runs through the Morton index rather than over the render buffer,
  /// because the render buffer is ONE fixed allocation reused by every
  /// query_points call — after a multi-layer refresh it holds only the last
  /// layer's points, so a caller that retained a handle per layer would be
  /// reading the wrong data and would never find out. The spatial index has no
  /// such problem: it is keyed by FactId over every geo fact in the store.
  ///
  /// `geo_attrs_csv` is the set of geometry attributes the caller is currently
  /// DISPLAYING, as decimal SymbolIds. The engine has no concept of a layer
  /// being switched off, and should not acquire one — visibility is a property
  /// of the view, so the view states it.
  ///
  /// Every symbol is resolved to text here rather than exposing the symbol
  /// table across the boundary: the same reasoning as audit_json and
  /// merge_evidence_json, which also hand back finished strings.
  [[nodiscard]] std::string inspect_json(f64 lat, f64 lon, f64 radius_m, Timestamp valid_at,
                                         u32 sys_at, std::string_view geo_attrs_csv) const;

  /// Undoes one accepted merge and recomputes the affected clustering.
  void unmerge_pair(u32 pair_index);

  [[nodiscard]] const ScanStats& last_scan() const noexcept { return last_scan_; }
  [[nodiscard]] f64 last_query_ms() const noexcept { return last_query_ms_; }

  // ── accessors ────────────────────────────────────────────────────────────

  [[nodiscard]] Store& store() noexcept { return store_; }
  [[nodiscard]] const Store& store() const noexcept { return store_; }
  [[nodiscard]] u32 generation() const noexcept { return generation_; }

  SymbolId intern(std::string_view s) { return store_.symbols().intern(s); }

 private:
  Store store_;

  // Reallocatable. JS reads the pointer immediately before each write.
  std::vector<u8> staging_;

  // Fixed capacity for the session's lifetime. Never resized after
  // construction — see the constructor comment.
  std::vector<wire::Point> points_;
  u32 point_capacity_ = 0;

  // Scratch for as_of results, reused across queries so a steady-state frame
  // loop performs no allocation at all.
  std::vector<FactId> scratch_;

  // Scalar-by-entity index, rebuilt per query. `scalar_stamp_` holds the query
  // counter that last wrote each slot, so staleness is detected by comparison
  // instead of by clearing the array — which at 100k entities would cost more
  // than the lookup it replaces.
  std::vector<f32> scalar_by_entity_;
  std::vector<u32> scalar_stamp_;
  u32 query_stamp_ = 0;

  GeoIndex geo_;

  PolicyEngine policy_;

  // Audit entities are allocated ABOVE every data entity so the two never
  // collide, and lazily so the store's CSR index — which sizes itself to the
  // largest entity id — is not forced to allocate a huge sparse array before
  // any audit entry exists.
  u32 next_audit_entity_ = 0;
  u32 audit_count_ = 0;

  er::Resolution resolution_;
  /// Resolution works on dense record indices; this maps them back to the
  /// EntityIds the rest of the engine uses.
  std::vector<u32> record_entity_;

  struct SourceBinding {
    std::string name;
    SymbolId geo_attr;
    SymbolId scalar_attr;
  };
  std::vector<SourceBinding> sources_;

  u32 generation_ = 1;
  ScanStats last_scan_{};
  f64 last_query_ms_ = 0.0;
};

}  // namespace px
