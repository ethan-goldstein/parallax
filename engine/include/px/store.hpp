// ── px/store.hpp ────────────────────────────────────────────────────────────
// The bitemporal fact store. This is the centre of the project.
//
// A fact is one source's assertion that some entity had some property value,
// over some interval of VALID time, believed over some interval of SYSTEM
// time. Storing both axes is what lets the engine answer the question that
// motivates PARALLAX:
//
//     "what did we believe at system-time S, about valid-time T?"
//
// ── system time is a transaction id, not a clock reading ───────────────────
//
// Every ingest batch gets a monotonically increasing TxnId, and a side table
// maps TxnId -> wall clock. Three reasons this is better than storing a
// timestamp directly:
//
//   1. Wall clock cannot order two writes inside the same millisecond. A
//      counter always can, so "as known at S" has exactly one answer.
//   2. It is 4 bytes rather than 8, and it participates in the same SIMD
//      predicate as the valid-time columns.
//   3. The UI scrubber's system axis snaps to real transactions instead of
//      sliding through timestamps at which nothing happened. That is better
//      interaction design, not a compromise forced by the storage choice.
//
// Datomic makes the same call for the same reasons.
//
// ── append-only, with exactly one mutation ─────────────────────────────────
//
// Asserting appends a row. Retracting writes sys_to on one existing row and
// touches nothing else. That write is monotone — kOpenSystem to some smaller
// value, never back — which is what lets readers treat the store as immutable
// without locking and lets the snapshot writer serialise columns with memcpy.
//
// ── layout ─────────────────────────────────────────────────────────────────
//
// Struct-of-arrays, logically chunked at kChunkRows. A scan evaluating the
// visibility predicate touches four i32/u32 columns and nothing else; in an
// array-of-structs layout each cache line fetched would be mostly payload the
// predicate never reads.
//
// 35 bytes per fact. Two million facts is about 70 MB, which fits the 256 MB
// browser heap with room for indexes and query scratch. That is the honest
// ceiling for the WASM target and the README says so.
// ────────────────────────────────────────────────────────────────────────────
#pragma once

#include <vector>

#include "px/ids.hpp"
#include "px/prelude.hpp"
#include "px/symbols.hpp"
#include "px/value.hpp"

namespace px {

/// Rows per chunk for the zone-map index. 8192 x 4 bytes = 32 KB per column
/// per chunk, so the columns a scan touches stay resident in L2 while a chunk
/// is processed. Power of two so chunk-of-row is a shift.
constexpr u32 kChunkRows = 8192;
constexpr u32 kChunkShift = 13;

/// Sentinel for "still believed". Chosen as u32 max so that the visibility
/// test `sys_at < sys_to` is true for live facts with no special case.
constexpr u32 kOpenSystem = 0xFFFF'FFFFu;

/// Sentinel for "still true". Same trick on the valid-time axis.
constexpr Timestamp kOpenValid = kTimeMax;

/// Per-chunk summary. The whole point: if the query's valid-time instant falls
/// outside [min_valid_from, max_valid_to) for a chunk, no row in that chunk
/// can match, and 8192 rows are skipped on one comparison.
///
/// This is what a real columnar engine calls a zone map, and it is about 30
/// lines. The skip rate is reported in EXPLAIN because it is the single most
/// informative number about why a query was fast or slow.
struct ChunkStats {
  Timestamp min_valid_from = kTimeMax;
  Timestamp max_valid_to = kTimeMin;
  u32 min_sys_from = kOpenSystem;
  u32 max_sys_to = 0;
  u32 row_count = 0;
};

struct TxnInfo {
  i64 wall_clock_unix = 0;
  SymbolId label{};
  u32 first_fact = 0;
  u32 fact_count = 0;
};

/// Statistics from one scan, surfaced in EXPLAIN. Filled during execution, so
/// estimated-vs-actual is a measurement rather than a guess.
struct ScanStats {
  u32 chunks_total = 0;
  u32 chunks_skipped = 0;
  u32 rows_scanned = 0;
  u32 rows_matched = 0;
};

class Store {
 public:
  Store();

  // ── writing ──────────────────────────────────────────────────────────────

  /// Opens a transaction. Every assert/retract between begin and commit shares
  /// one TxnId and therefore one point on the system-time axis.
  TxnId begin_txn(i64 wall_clock_unix, SymbolId label = SymbolId{});
  void commit_txn();

  /// Appends a fact. `valid_to` is exclusive; pass kOpenValid for "still true".
  FactId assert_fact(EntityId entity, SymbolId attr, Value value, Timestamp valid_from,
                     Timestamp valid_to, SourceId source);

  /// Marks a fact as no longer believed, as of the open transaction.
  /// Idempotent: retracting an already-retracted fact does nothing, because
  /// sources re-send corrections and that must not corrupt history.
  void retract(FactId fact);

  // ── reading ──────────────────────────────────────────────────────────────

  /// The bitemporal slice: facts believed at system time `sys_at` that were
  /// true at valid time `valid_at`. Appends matching FactIds to `out`.
  ///
  /// Both intervals are half-open [from, to), so consecutive versions of a
  /// property tile the timeline exactly — no overlap, no gap.
  void as_of(Timestamp valid_at, TxnId sys_at, std::vector<FactId>& out,
             ScanStats* stats = nullptr) const;

  /// Which scan kernel as_of() will use.
  enum class Kernel : u8 { Scalar, Simd };

  /// Forces a kernel, for benchmarking ONLY.
  ///
  /// Both must return identical results — the differential test in
  /// tests/test_store.cpp runs against whichever is selected, so a SIMD lane
  /// bug fails the same property the scalar version is held to. Publishing a
  /// speedup for a kernel that is not also proven correct would be worthless.
  void as_of_with(Kernel k, Timestamp valid_at, TxnId sys_at, std::vector<FactId>& out,
                  ScanStats* stats = nullptr) const;

  /// Whether this build actually has a vectorised kernel.
  [[nodiscard]] static bool simd_available() noexcept;

  /// Raw pointers to the four columns the visibility predicate reads.
  ///
  /// Exposed for ONE purpose: so the in-browser benchmark can run the identical
  /// predicate from JavaScript over the identical memory. A "C++ vs JS"
  /// comparison where the two sides read different data, or where JS has to
  /// marshal a copy first, measures the marshalling and proves nothing. Same
  /// bytes, same predicate, different language.
  [[nodiscard]] const u32* sys_from_data() const noexcept { return sys_from_.data(); }
  [[nodiscard]] const u32* sys_to_data() const noexcept { return sys_to_.data(); }
  [[nodiscard]] const i32* valid_from_data() const noexcept { return valid_from_.data(); }
  [[nodiscard]] const i32* valid_to_data() const noexcept { return valid_to_.data(); }

  /// Same slice, restricted to one entity, served from the CSR index rather
  /// than by scanning: entity_offset_[e]..entity_offset_[e+1] is a contiguous
  /// range of that entity's rows.
  void as_of_entity(EntityId entity, Timestamp valid_at, TxnId sys_at,
                    std::vector<FactId>& out, ScanStats* stats = nullptr) const;

  /// Rebuilds the entity index. O(n), counting sort, one allocation. Called
  /// after a bulk ingest rather than per fact — maintaining it incrementally
  /// would cost more than rebuilding for the batch sizes involved here.
  void rebuild_entity_index();

  /// The visibility predicate for a single fact.
  ///
  /// Exposed so the spatial access path can reuse it: the Morton index yields
  /// candidates by location and each one still has to pass the bitemporal
  /// test. Having exactly one implementation of this predicate is what keeps
  /// the two access paths from disagreeing about what is visible.
  [[nodiscard]] bool visible_at(FactId f, Timestamp valid_at, TxnId sys_at) const noexcept;

  /// How many chunks the zone maps can prove cannot match.
  ///
  /// Runs the same test as_of() will, once per chunk — one comparison per 8192
  /// rows. Cheap enough to call at PLAN time, which is what makes the
  /// ZoneMapScan cardinality estimate exact rather than modelled, and it means
  /// the planner and the executor cannot drift apart.
  [[nodiscard]] u32 count_skippable_chunks(Timestamp valid_at, u32 sys_at) const noexcept;

  /// The last transaction committed at or before `wall_clock_unix`.
  ///
  /// The system axis is a transaction index, not a clock, so "as we believed
  /// at 14:00" means the newest transaction that had happened by 14:00.
  /// Transactions are appended in wall-clock order (main.ts sorts batches
  /// before ingest precisely so this holds), so this is a binary search.
  [[nodiscard]] u32 txn_at_or_before(i64 wall_clock_unix) const noexcept;

  // ── accessors ────────────────────────────────────────────────────────────

  [[nodiscard]] usize fact_count() const noexcept { return entity_.size(); }
  [[nodiscard]] usize chunk_count() const noexcept { return chunks_.size(); }
  [[nodiscard]] TxnId current_txn() const noexcept { return TxnId{next_txn_ - 1}; }

  [[nodiscard]] EntityId fact_entity(FactId f) const noexcept {
    return EntityId{entity_[f.index()]};
  }
  [[nodiscard]] SymbolId fact_attr(FactId f) const noexcept {
    return SymbolId{attr_[f.index()]};
  }
  [[nodiscard]] Value fact_value(FactId f) const noexcept {
    return Value{vbits_[f.index()], static_cast<Kind>(vkind_[f.index()])};
  }
  [[nodiscard]] Timestamp fact_valid_from(FactId f) const noexcept {
    return valid_from_[f.index()];
  }
  [[nodiscard]] Timestamp fact_valid_to(FactId f) const noexcept {
    return valid_to_[f.index()];
  }
  [[nodiscard]] u32 fact_sys_from(FactId f) const noexcept { return sys_from_[f.index()]; }
  [[nodiscard]] u32 fact_sys_to(FactId f) const noexcept { return sys_to_[f.index()]; }
  [[nodiscard]] SourceId fact_source(FactId f) const noexcept {
    return SourceId{source_[f.index()]};
  }

  [[nodiscard]] const std::vector<TxnInfo>& transactions() const noexcept { return txns_; }
  [[nodiscard]] SymbolTable& symbols() noexcept { return symbols_; }
  [[nodiscard]] const SymbolTable& symbols() const noexcept { return symbols_; }

  /// Approximate resident bytes. Reported in the UI so the memory claim in the
  /// README is something a visitor can check rather than take on trust.
  [[nodiscard]] usize heap_bytes() const noexcept;

  void reserve(usize facts);

 private:
  void update_chunk_stats(u32 row);
  [[nodiscard]] bool chunk_can_match(const ChunkStats& c, Timestamp valid_at,
                                     u32 sys_at) const noexcept;
  [[nodiscard]] u32 upper_row_for_txn(u32 sys_at) const noexcept;

  // Parallel columns. Row i of each describes fact i.
  std::vector<u32> entity_;
  std::vector<u32> attr_;
  std::vector<u64> vbits_;
  std::vector<u8> vkind_;
  std::vector<Timestamp> valid_from_;
  std::vector<Timestamp> valid_to_;
  std::vector<u32> sys_from_;
  std::vector<u32> sys_to_;
  std::vector<u16> source_;

  std::vector<ChunkStats> chunks_;

  // Entity index, CSR-shaped. Rebuilt in bulk; empty until rebuild.
  std::vector<u32> entity_offset_;
  std::vector<u32> entity_facts_;
  bool entity_index_valid_ = false;

  std::vector<TxnInfo> txns_;
  u32 next_txn_ = 0;
  bool txn_open_ = false;

  SymbolTable symbols_;
};

}  // namespace px
