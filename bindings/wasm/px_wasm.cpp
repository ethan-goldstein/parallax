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

#include <algorithm>
#include <vector>

#include "px/bench.hpp"
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

JsQueryResult pack_query(const px::Session::QueryOutcome& r) {
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

JsQueryResult run_query(const std::string& sql, double now_unix) {
  return pack_query(session().run_query(sql, static_cast<px::i64>(now_unix)));
}

/// The same query, pinned to the scrubber's two axes.
///
/// `sys_at` is a transaction INDEX, passed through unconverted. Going via a wall
/// clock would be lossy: several transactions routinely share a second, so the
/// index that came back would not be the one the user selected.
///
/// `record` is false while only the temporal position is changing, so dragging
/// the scrubber does not write one audit fact per frame.
JsQueryResult run_query_at(const std::string& sql, double now_unix, double valid_at,
                           double sys_at, bool record) {
  px::QueryOptions opts;
  opts.has_time_override = true;
  opts.valid_at = static_cast<px::Timestamp>(valid_at);
  opts.sys_at = static_cast<px::u32>(sys_at);
  opts.record = record;
  return pack_query(session().run_query(sql, static_cast<px::i64>(now_unix), opts));
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

/// Nearest visible point to a click, with everything knowable about it.
///
/// Note what this does NOT take: a FactId. Store's fact accessors index raw
/// vectors with no bounds check, so handing JavaScript a row index to pass back
/// would put an out-of-bounds read one typo away. The caller supplies a position
/// and the engine chooses the row, which makes the unchecked accessors
/// unreachable from outside.
std::string inspect(double lat, double lon, double radius_m, int valid_at, u32 sys_at,
                    const std::string& geo_attrs) {
  return session().inspect_json(lat, lon, radius_m, static_cast<px::Timestamp>(valid_at), sys_at,
                                geo_attrs);
}

void unmerge_pair(u32 pair_index) {
  session().unmerge_pair(pair_index);
}

// ── in-browser benchmark ───────────────────────────────────────────────────
//
// The point of running this in the visitor's browser rather than quoting a
// number from my machine: there is nothing to take on trust. The same
// predicate runs over the same memory in both languages, on their hardware,
// right now.

struct JsBenchResult {
  double scalarMs = 0;
  double simdMs = 0;
  u32 rowsScanned = 0;
  u32 rowsMatched = 0;
  bool simdAvailable = false;
  /// Heap addresses of the four predicate columns, so JS can run the identical
  /// loop over the identical bytes.
  u32 sysFromPtr = 0;
  u32 sysToPtr = 0;
  u32 validFromPtr = 0;
  u32 validToPtr = 0;
  u32 factCount = 0;
  /// How many repetitions the timing was averaged over — reported so the
  /// measurement can be judged rather than trusted.
  u32 reps = 0;
  int validAt = 0;
  u32 sysAt = 0;
};

JsBenchResult bench_scan(int target_ms) {
  px::Store& st = session().store();
  JsBenchResult r;
  r.factCount = static_cast<u32>(st.fact_count());
  r.simdAvailable = px::Store::simd_available();
  if (r.factCount == 0) return r;

  // A (T, S) at which nothing is prunable, so the kernel is measured doing
  // real work on every row rather than the zone maps being measured instead.
  r.validAt = px::kTimeMax - 1;
  r.sysAt = st.current_txn().v;

  std::vector<px::FactId> out;
  out.reserve(r.factCount);

  // REPEAT UNTIL MEASURABLE, then divide.
  //
  // Browsers deliberately coarsen performance.now() — typically to ~100 us, as
  // a Spectre mitigation. A single scan over ~12k rows takes far less than
  // that, so timing one iteration measured a single timer tick: the first
  // version reported 0.1 ms for scalar and 0.0 ms for SIMD, which is noise
  // wearing the costume of a result.
  //
  // Running until the clock has advanced well past its own resolution and
  // dividing by the repetition count is the standard fix, and it is why this
  // takes a target duration rather than an iteration count.
  auto run = [&](px::Store::Kernel k) {
    // Warmup: one pass to fault in pages and warm caches.
    out.clear();
    st.as_of_with(k, r.validAt, px::TxnId{r.sysAt}, out, nullptr);

    const double budget = target_ms > 0 ? target_ms : 50;
    const double t0 = px::now_ms();
    int reps = 0;
    double elapsed = 0;
    do {
      out.clear();
      px::ScanStats s{};
      st.as_of_with(k, r.validAt, px::TxnId{r.sysAt}, out, &s);
      r.rowsScanned = s.rows_scanned;
      r.rowsMatched = static_cast<u32>(out.size());
      ++reps;
      elapsed = px::now_ms() - t0;
    } while (elapsed < budget && reps < 100000);

    r.reps = reps;
    return reps > 0 ? elapsed / reps : 0.0;
  };

  r.scalarMs = run(px::Store::Kernel::Scalar);
  if (r.simdAvailable) r.simdMs = run(px::Store::Kernel::Simd);

  r.sysFromPtr = heap_addr(st.sys_from_data());
  r.sysToPtr = heap_addr(st.sys_to_data());
  r.validFromPtr = heap_addr(st.valid_from_data());
  r.validToPtr = heap_addr(st.valid_to_data());
  return r;
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

  emscripten::value_object<JsBenchResult>("BenchResult")
      .field("scalarMs", &JsBenchResult::scalarMs)
      .field("simdMs", &JsBenchResult::simdMs)
      .field("rowsScanned", &JsBenchResult::rowsScanned)
      .field("rowsMatched", &JsBenchResult::rowsMatched)
      .field("simdAvailable", &JsBenchResult::simdAvailable)
      .field("sysFromPtr", &JsBenchResult::sysFromPtr)
      .field("sysToPtr", &JsBenchResult::sysToPtr)
      .field("validFromPtr", &JsBenchResult::validFromPtr)
      .field("validToPtr", &JsBenchResult::validToPtr)
      .field("factCount", &JsBenchResult::factCount)
      .field("reps", &JsBenchResult::reps)
      .field("validAt", &JsBenchResult::validAt)
      .field("sysAt", &JsBenchResult::sysAt);

  emscripten::function("benchScan", &bench_scan);
  emscripten::function("setPurpose", &set_purpose);
  emscripten::function("setSensitivity", &set_sensitivity);
  emscripten::function("auditLog", &audit_log);
  emscripten::function("finishIngest", &finish_ingest);
  emscripten::function("resolveEntities", &resolve_entities);
  emscripten::function("mergeEvidence", &merge_evidence);
  emscripten::function("inspect", &inspect);
  emscripten::function("unmergePair", &unmerge_pair);

  emscripten::function("registerSource", &register_source);
  emscripten::function("runQuery", &run_query);
  emscripten::function("runQueryAt", &run_query_at);

  emscripten::function("lastScan", &last_scan);
  emscripten::function("factCount", &fact_count);
  emscripten::function("txnCount", &txn_count);
  emscripten::function("currentTxn", &current_txn);
  emscripten::function("generation", &generation);
  emscripten::function("heapBytes", &heap_bytes);
  emscripten::function("txnWallClock", &txn_wall_clock);
  emscripten::function("txnFactCount", &txn_fact_count);
}
