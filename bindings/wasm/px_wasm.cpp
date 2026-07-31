// ── bindings/wasm/px_wasm.cpp ───────────────────────────────────────────────
// The ONLY file in the project permitted to include <emscripten/*>, and the
// only place that knows a pointer fits in 32 bits.
//
// The engine deals in real pointers and in offsets (see px/session.hpp). This
// file is where a pointer becomes a heap address JavaScript can build a
// DataView over. Keeping that narrowing in one place is what lets the whole
// engine compile and be tested natively, where pointers are 64-bit.
//
// The embind surface is capped at ~20 functions on purpose. embind is right
// for the control plane — a few calls per second that need strings and
// structured returns — and wrong for bulk data, where emscripten::val and
// register_vector copy far more than the docs imply. Every high-volume path
// travels as raw bytes through a pointer instead, and never appears below.
// ────────────────────────────────────────────────────────────────────────────
#include <emscripten/bind.h>

#include <memory>
#include <string>

#include "px/session.hpp"
#include "px/version.hpp"

namespace {

// Pulled in individually rather than `using namespace px`, so it stays obvious
// which names here belong to the engine and which are local to the binding.
using px::u32;
using px::usize;

// One session per tab. A second one would mean a second store and a second set
// of buffers, and a selection bitset that silently referred to the wrong one.
std::unique_ptr<px::Session> g_session;

px::Session& session() {
  if (!g_session) g_session = std::make_unique<px::Session>();
  return *g_session;
}

/// Narrows a real pointer to a wasm heap address.
///
/// Safe here and nowhere else: under wasm32 the entire linear memory is
/// addressable in 32 bits, so this is a lossless conversion. The same line in
/// the engine would truncate a 64-bit native pointer.
u32 heap_addr(const void* p) {
  return static_cast<u32>(reinterpret_cast<usize>(p));
}

// ── plain values crossing to JS ────────────────────────────────────────────

struct JsBufferRef {
  u32 ptr = 0;
  u32 count = 0;
  u32 stride = 0;
  u32 generation = 0;
  u32 truncated = 0;
};

struct JsIngestResult {
  u32 accepted = 0;
  u32 rejected = 0;
  u32 txn = 0;
};

struct JsScanStats {
  u32 chunksTotal = 0;
  u32 chunksSkipped = 0;
  u32 rowsScanned = 0;
  u32 rowsMatched = 0;
  double queryMs = 0.0;
};

// ── control plane ──────────────────────────────────────────────────────────

void init(u32 max_points) {
  g_session = std::make_unique<px::Session>(max_points);
}

u32 intern(const std::string& s) {
  return session().intern(s).v;
}

u32 staging_ptr(u32 bytes) {
  return heap_addr(session().staging_buffer(bytes));
}

JsIngestResult ingest(u32 byte_offset, u32 byte_len, double wall_clock_unix) {
  const px::IngestResult r =
      session().ingest(byte_offset, byte_len, static_cast<px::i64>(wall_clock_unix));
  return JsIngestResult{r.accepted, r.rejected, r.txn.v};
}

JsBufferRef query_points(int valid_at, u32 sys_at, u32 geo_attr, u32 scalar_attr) {
  const px::Session::PointBatch b = session().query_points(
      static_cast<px::Timestamp>(valid_at), sys_at, px::SymbolId{geo_attr},
      px::SymbolId{scalar_attr});

  return JsBufferRef{heap_addr(b.data), b.count,
                     static_cast<u32>(sizeof(px::wire::Point)), b.generation, b.truncated};
}

// ── query language ─────────────────────────────────────────────────────────

struct JsQueryResult {
  JsBufferRef buffer;
  bool ok = false;
  std::string error;
  u32 errorBegin = 0;
  u32 errorEnd = 0;
  /// EXPLAIN as a JSON string. Correct choice here precisely because the
  /// record is small and human-readable — the same choice would be wrong for
  /// the point buffer, which is why that travels as raw memory instead.
  std::string explain;

  /// A refusal is reported separately from `error`: "you typed something
  /// invalid" and "you asked something you are not authorised to ask" are
  /// different answers, and a UI that conflates them tells the user to fix
  /// their syntax when there is nothing wrong with it.
  bool denied = false;
  std::string ruleId;
  std::string denialExplanation;
  std::string denialOffending;
  std::string denialRemedy;
};

void register_source(const std::string& name, u32 geo_attr, u32 scalar_attr) {
  session().register_source(name, px::SymbolId{geo_attr}, px::SymbolId{scalar_attr});
}

JsQueryResult run_query(const std::string& sql, double now_unix) {
  const px::Session::QueryOutcome r =
      session().run_query(sql, static_cast<px::i64>(now_unix));

  JsQueryResult out;
  out.ok = r.ok;
  out.error = r.error;
  out.errorBegin = r.error_begin;
  out.errorEnd = r.error_end;
  out.explain = r.explain;
  out.denied = r.denied;
  out.ruleId = r.rule_id;
  out.denialExplanation = r.denial_explanation;
  out.denialOffending = r.denial_offending;
  out.denialRemedy = r.denial_remedy;
  out.buffer = JsBufferRef{heap_addr(r.batch.data), r.batch.count,
                           static_cast<u32>(sizeof(px::wire::Point)), r.batch.generation,
                           r.batch.truncated};
  return out;
}

// ── entity resolution ──────────────────────────────────────────────────────

struct JsErStats {
  u32 records = 0;
  u32 pairsCompared = 0;
  u32 pairsAccepted = 0;
  u32 clusters = 0;
  u32 mergedRecords = 0;
  u32 blocksSkipped = 0;
  double elapsedMs = 0.0;
};

JsErStats resolve_entities(u32 geo_attr, u32 scalar_attr) {
  const px::er::ErStats s =
      session().resolve_entities(px::SymbolId{geo_attr}, px::SymbolId{scalar_attr});
  return JsErStats{s.records,        s.pairs_compared, s.pairs_accepted, s.clusters,
                   s.merged_records, s.blocks_skipped, s.elapsed_ms};
}

bool set_purpose(const std::string& name) {
  return session().set_purpose(name);
}

void set_sensitivity(u32 attr, u32 level) {
  const px::Sensitivity s = level >= 2   ? px::Sensitivity::PersonLinked
                            : level == 1 ? px::Sensitivity::Precise
                                         : px::Sensitivity::Public;
  session().set_sensitivity(px::SymbolId{attr}, s);
}

std::string audit_log(u32 limit) {
  return session().audit_json(limit);
}

void finish_ingest() {
  session().finish_ingest();
}

std::string merge_evidence(u32 limit) {
  return session().merge_evidence_json(limit);
}

void unmerge_pair(u32 pair_index) {
  session().unmerge_pair(pair_index);
}

JsScanStats last_scan() {
  const px::ScanStats& s = session().last_scan();
  return JsScanStats{s.chunks_total, s.chunks_skipped, s.rows_scanned, s.rows_matched,
                     session().last_query_ms()};
}

u32 fact_count() { return static_cast<u32>(session().store().fact_count()); }
u32 txn_count() { return static_cast<u32>(session().store().transactions().size()); }
u32 current_txn() { return session().store().current_txn().v; }
u32 generation() { return session().generation(); }
double heap_bytes() { return static_cast<double>(session().store().heap_bytes()); }

/// Wall-clock time of a transaction, as unix seconds. The scrubber's system
/// axis is a transaction index; this is what labels it with something a human
/// can read.
double txn_wall_clock(u32 i) {
  const auto& t = session().store().transactions();
  if (i >= t.size()) return 0.0;
  return static_cast<double>(t[i].wall_clock_unix);
}

u32 txn_fact_count(u32 i) {
  const auto& t = session().store().transactions();
  if (i >= t.size()) return 0;
  return t[i].fact_count;
}

std::string version() { return std::string(px::version()); }
std::string build_target() { return std::string(px::build_target()); }
bool has_simd() { return px::has_simd(); }

}  // namespace

EMSCRIPTEN_BINDINGS(parallax) {
  emscripten::value_object<JsBufferRef>("BufferRef")
      .field("ptr", &JsBufferRef::ptr)
      .field("count", &JsBufferRef::count)
      .field("stride", &JsBufferRef::stride)
      .field("generation", &JsBufferRef::generation)
      .field("truncated", &JsBufferRef::truncated);

  emscripten::value_object<JsIngestResult>("IngestResult")
      .field("accepted", &JsIngestResult::accepted)
      .field("rejected", &JsIngestResult::rejected)
      .field("txn", &JsIngestResult::txn);

  emscripten::value_object<JsScanStats>("ScanStats")
      .field("chunksTotal", &JsScanStats::chunksTotal)
      .field("chunksSkipped", &JsScanStats::chunksSkipped)
      .field("rowsScanned", &JsScanStats::rowsScanned)
      .field("rowsMatched", &JsScanStats::rowsMatched)
      .field("queryMs", &JsScanStats::queryMs);

  emscripten::function("version", &version);
  emscripten::function("buildTarget", &build_target);
  emscripten::function("hasSimd", &has_simd);

  emscripten::function("init", &init);
  emscripten::function("intern", &intern);
  emscripten::function("stagingPtr", &staging_ptr);
  emscripten::function("ingest", &ingest);
  emscripten::function("queryPoints", &query_points);

  emscripten::value_object<JsQueryResult>("QueryResult")
      .field("buffer", &JsQueryResult::buffer)
      .field("ok", &JsQueryResult::ok)
      .field("error", &JsQueryResult::error)
      .field("errorBegin", &JsQueryResult::errorBegin)
      .field("errorEnd", &JsQueryResult::errorEnd)
      .field("explain", &JsQueryResult::explain)
      .field("denied", &JsQueryResult::denied)
      .field("ruleId", &JsQueryResult::ruleId)
      .field("denialExplanation", &JsQueryResult::denialExplanation)
      .field("denialOffending", &JsQueryResult::denialOffending)
      .field("denialRemedy", &JsQueryResult::denialRemedy);

  emscripten::value_object<JsErStats>("ErStats")
      .field("records", &JsErStats::records)
      .field("pairsCompared", &JsErStats::pairsCompared)
      .field("pairsAccepted", &JsErStats::pairsAccepted)
      .field("clusters", &JsErStats::clusters)
      .field("mergedRecords", &JsErStats::mergedRecords)
      .field("blocksSkipped", &JsErStats::blocksSkipped)
      .field("elapsedMs", &JsErStats::elapsedMs);

  emscripten::function("setPurpose", &set_purpose);
  emscripten::function("setSensitivity", &set_sensitivity);
  emscripten::function("auditLog", &audit_log);
  emscripten::function("finishIngest", &finish_ingest);
  emscripten::function("resolveEntities", &resolve_entities);
  emscripten::function("mergeEvidence", &merge_evidence);
  emscripten::function("unmergePair", &unmerge_pair);

  emscripten::function("registerSource", &register_source);
  emscripten::function("runQuery", &run_query);

  emscripten::function("lastScan", &last_scan);
  emscripten::function("factCount", &fact_count);
  emscripten::function("txnCount", &txn_count);
  emscripten::function("currentTxn", &current_txn);
  emscripten::function("generation", &generation);
  emscripten::function("heapBytes", &heap_bytes);
  emscripten::function("txnWallClock", &txn_wall_clock);
  emscripten::function("txnFactCount", &txn_fact_count);
}
