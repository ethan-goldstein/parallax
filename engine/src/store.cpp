#include "px/store.hpp"

#include <algorithm>

#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

namespace px {

Store::Store() {
  // Transaction 0 is reserved as "before anything was known". Querying at
  // sys_at = 0 therefore returns nothing rather than being an error, which
  // makes the scrubber's leftmost position meaningful instead of a special
  // case the UI has to handle.
  txns_.push_back(TxnInfo{0, SymbolId{}, 0, 0});
  next_txn_ = 1;
}

void Store::reserve(usize facts) {
  entity_.reserve(facts);
  attr_.reserve(facts);
  vbits_.reserve(facts);
  vkind_.reserve(facts);
  valid_from_.reserve(facts);
  valid_to_.reserve(facts);
  sys_from_.reserve(facts);
  sys_to_.reserve(facts);
  source_.reserve(facts);
  chunks_.reserve(facts / kChunkRows + 1);
}

// ── transactions ───────────────────────────────────────────────────────────

TxnId Store::begin_txn(i64 wall_clock_unix, SymbolId label) {
  PX_ASSERT(!txn_open_, "begin_txn called while a transaction is already open");

  const u32 id = next_txn_++;
  txns_.push_back(TxnInfo{wall_clock_unix, label, static_cast<u32>(entity_.size()), 0});
  txn_open_ = true;
  return TxnId{id};
}

void Store::commit_txn() {
  PX_ASSERT(txn_open_, "commit_txn called with no open transaction");
  if (!txn_open_) return;

  TxnInfo& t = txns_.back();
  t.fact_count = static_cast<u32>(entity_.size()) - t.first_fact;
  txn_open_ = false;
}

// ── writing ────────────────────────────────────────────────────────────────

FactId Store::assert_fact(EntityId entity, SymbolId attr, Value value,
                          Timestamp valid_from, Timestamp valid_to, SourceId source) {
  PX_ASSERT(txn_open_, "assert_fact outside a transaction");
  PX_ASSERT(valid_from <= valid_to, "valid interval must not run backwards");

  const u32 row = static_cast<u32>(entity_.size());

  entity_.push_back(entity.v);
  attr_.push_back(attr.v);
  vbits_.push_back(value.bits);
  vkind_.push_back(static_cast<u8>(value.kind));
  valid_from_.push_back(valid_from);
  valid_to_.push_back(valid_to);
  sys_from_.push_back(next_txn_ - 1);
  sys_to_.push_back(kOpenSystem);
  source_.push_back(static_cast<u16>(source.v));

  update_chunk_stats(row);

  // The new row is not in the entity index. Callers rebuild after a batch;
  // as_of_entity falls back to a scan while the index is stale, so a forgotten
  // rebuild is a performance bug, never a correctness one.
  entity_index_valid_ = false;

  return FactId{row};
}

void Store::retract(FactId fact) {
  PX_ASSERT(txn_open_, "retract outside a transaction");
  if (!fact.valid() || fact.index() >= sys_to_.size()) return;

  // Idempotent by design. Feeds re-send corrections, and a second retraction
  // must not rewrite history to an earlier transaction — that would make a
  // fact appear to have been disbelieved before it actually was.
  if (sys_to_[fact.index()] != kOpenSystem) return;

  sys_to_[fact.index()] = next_txn_ - 1;

  // The zone map's max_sys_to must not shrink. It is an upper bound used only
  // to prove "no row here can match", so widening it stays conservative;
  // narrowing it could skip a chunk that does contain a match.
  const u32 chunk = fact.v >> kChunkShift;
  if (chunk < chunks_.size()) {
    ChunkStats& c = chunks_[chunk];
    c.max_sys_to = std::max(c.max_sys_to, next_txn_ - 1);
  }
}

void Store::update_chunk_stats(u32 row) {
  const u32 chunk = row >> kChunkShift;
  if (chunk >= chunks_.size()) chunks_.resize(chunk + 1);

  ChunkStats& c = chunks_[chunk];
  c.min_valid_from = std::min(c.min_valid_from, valid_from_[row]);
  c.max_valid_to = std::max(c.max_valid_to, valid_to_[row]);
  c.min_sys_from = std::min(c.min_sys_from, sys_from_[row]);
  c.max_sys_to = std::max(c.max_sys_to, sys_to_[row]);
  ++c.row_count;
}

// ── reading ────────────────────────────────────────────────────────────────

bool Store::chunk_can_match(const ChunkStats& c, Timestamp valid_at,
                            u32 sys_at) const noexcept {
  if (c.row_count == 0) return false;

  // Valid-time bound. Rows are visible when valid_from <= T < valid_to, so a
  // chunk can only contain a match if T is inside the union of its intervals.
  //
  // Note max_valid_to is an EXCLUSIVE bound and the comparison is >=, not >.
  // A chunk whose latest valid_to equals T contains no row valid at T,
  // because the interval is half-open. Getting this wrong is a one-character
  // bug that produces a phantom extra row at exactly one instant — precisely
  // what the differential test is here to catch.
  if (valid_at < c.min_valid_from) return false;
  if (valid_at >= c.max_valid_to) return false;

  // System-time bound. Rows are visible when sys_from <= S, so a chunk whose
  // earliest transaction is after S cannot contain one.
  if (sys_at < c.min_sys_from) return false;

  return true;
}

u32 Store::upper_row_for_txn(u32 sys_at) const noexcept {
  // sys_from_ is non-decreasing by construction — rows are appended in
  // transaction order and the column is never rewritten. So the set of rows
  // with sys_from <= sys_at is always a prefix, and its end is one binary
  // search. Free, exact, and it needs no maintenance.
  const auto begin = sys_from_.begin();
  const auto it = std::upper_bound(begin, sys_from_.end(), sys_at);
  return static_cast<u32>(it - begin);
}

bool Store::simd_available() noexcept {
#ifdef __wasm_simd128__
  return true;
#else
  return false;
#endif
}

namespace {

/// Scan one chunk with the scalar kernel. Returns rows matched.
///
/// Written first, and kept forever: it is the reference the vectorised kernel
/// is checked against, and the only kernel on targets without SIMD.
inline void scan_scalar(u32 begin, u32 end, i32 valid_at, u32 s,
                        const std::vector<u32>& sys_from, const std::vector<u32>& sys_to,
                        const std::vector<i32>& valid_from, const std::vector<i32>& valid_to,
                        std::vector<FactId>& out) {
  for (u32 i = begin; i < end; ++i) {
    // Bitwise & on deliberately int-ified comparisons, not &&. Short-circuit
    // would introduce a data-dependent branch per row, and at ~50% match rates
    // the predictor cannot help — the mispredicts cost more than evaluating
    // both sides always.
    const int known_then =
        static_cast<int>(sys_from[i] <= s) & static_cast<int>(s < sys_to[i]);
    const int true_then = static_cast<int>(valid_from[i] <= valid_at) &
                          static_cast<int>(valid_at < valid_to[i]);
    if ((known_then & true_then) != 0) out.push_back(FactId{i});
  }
}

#ifdef __wasm_simd128__
/// Vectorised kernel: four rows per iteration.
///
/// All four columns are 32-bit — which is WHY they are 32-bit. A 64-bit
/// timestamp would halve the lanes and roughly halve this speedup, and that
/// tradeoff is the reason px/value.hpp accepts one-second resolution.
///
/// Note the mixed signedness: sys_* are u32 (transaction ids) and valid_* are
/// i32 (signed seconds), so the comparisons must use the u32x4 and i32x4
/// variants respectively. Using the signed compare on transaction ids would
/// silently misclassify every id above 2^31.
inline void scan_simd(u32 begin, u32 end, i32 valid_at, u32 s,
                      const std::vector<u32>& sys_from, const std::vector<u32>& sys_to,
                      const std::vector<i32>& valid_from, const std::vector<i32>& valid_to,
                      std::vector<FactId>& out) {
  const v128_t vs = wasm_u32x4_splat(s);
  const v128_t vt = wasm_i32x4_splat(valid_at);

  u32 i = begin;
  for (; i + 4 <= end; i += 4) {
    const v128_t sf = wasm_v128_load(&sys_from[i]);
    const v128_t st = wasm_v128_load(&sys_to[i]);
    const v128_t vf = wasm_v128_load(&valid_from[i]);
    const v128_t vto = wasm_v128_load(&valid_to[i]);

    const v128_t known = wasm_v128_and(wasm_u32x4_le(sf, vs), wasm_u32x4_lt(vs, st));
    const v128_t truth = wasm_v128_and(wasm_i32x4_le(vf, vt), wasm_i32x4_lt(vt, vto));
    const v128_t mask = wasm_v128_and(known, truth);

    // One branch per four rows instead of per row. At the sparse match rates
    // this store sees, most groups are entirely empty and skip the extracts.
    if (!wasm_v128_any_true(mask)) continue;

    if (wasm_i32x4_extract_lane(mask, 0)) out.push_back(FactId{i});
    if (wasm_i32x4_extract_lane(mask, 1)) out.push_back(FactId{i + 1});
    if (wasm_i32x4_extract_lane(mask, 2)) out.push_back(FactId{i + 2});
    if (wasm_i32x4_extract_lane(mask, 3)) out.push_back(FactId{i + 3});
  }

  // Tail. Chunks are 8192 rows so this only runs on the final partial chunk,
  // but getting it wrong would drop up to three facts — exactly the kind of
  // silent wrongness the differential test exists to catch.
  scan_scalar(i, end, valid_at, s, sys_from, sys_to, valid_from, valid_to, out);
}
#endif

}  // namespace

void Store::as_of_with(Kernel kernel, Timestamp valid_at, TxnId sys_at,
                       std::vector<FactId>& out, ScanStats* stats) const {
  const u32 s = sys_at.v;
  const u32 row_limit = upper_row_for_txn(s);

  ScanStats local{};
  local.chunks_total = static_cast<u32>(chunks_.size());

  for (u32 chunk = 0; chunk < chunks_.size(); ++chunk) {
    const u32 begin = chunk << kChunkShift;
    if (begin >= row_limit) break;  // every later chunk is also out of range

    if (!chunk_can_match(chunks_[chunk], valid_at, s)) {
      ++local.chunks_skipped;
      continue;
    }

    const u32 end = std::min(begin + kChunkRows, row_limit);

#ifdef __wasm_simd128__
    if (kernel == Kernel::Simd) {
      scan_simd(begin, end, valid_at, s, sys_from_, sys_to_, valid_from_, valid_to_, out);
    } else {
      scan_scalar(begin, end, valid_at, s, sys_from_, sys_to_, valid_from_, valid_to_, out);
    }
#else
    (void)kernel;
    scan_scalar(begin, end, valid_at, s, sys_from_, sys_to_, valid_from_, valid_to_, out);
#endif

    local.rows_scanned += end - begin;
  }

  local.rows_matched = static_cast<u32>(out.size());
  if (stats) *stats = local;
}

void Store::as_of(Timestamp valid_at, TxnId sys_at, std::vector<FactId>& out,
                  ScanStats* stats) const {
  as_of_with(simd_available() ? Kernel::Simd : Kernel::Scalar, valid_at, sys_at, out, stats);
}

bool Store::visible_at(FactId f, Timestamp valid_at, TxnId sys_at) const noexcept {
  if (!f.valid() || f.index() >= entity_.size()) return false;
  const usize i = f.index();
  const u32 s = sys_at.v;

  const int known_then =
      static_cast<int>(sys_from_[i] <= s) & static_cast<int>(s < sys_to_[i]);
  const int true_then = static_cast<int>(valid_from_[i] <= valid_at) &
                        static_cast<int>(valid_at < valid_to_[i]);
  return (known_then & true_then) != 0;
}

u32 Store::count_skippable_chunks(Timestamp valid_at, u32 sys_at) const noexcept {
  const u32 row_limit = upper_row_for_txn(sys_at);
  u32 skipped = 0;

  for (u32 chunk = 0; chunk < chunks_.size(); ++chunk) {
    const u32 begin = chunk << kChunkShift;
    if (begin >= row_limit) {
      // Beyond the system-time cutoff: unreachable, which is a skip of a
      // different kind but a skip nonetheless — the scan will not touch it.
      ++skipped;
      continue;
    }
    if (!chunk_can_match(chunks_[chunk], valid_at, sys_at)) ++skipped;
  }
  return skipped;
}

u32 Store::txn_at_or_before(i64 wall_clock_unix) const noexcept {
  if (txns_.empty()) return 0;

  // Transactions are appended in ascending wall-clock order — the ingest layer
  // sorts batches before committing precisely so this invariant holds — so a
  // binary search is valid. If it were ever violated the result would be wrong
  // rather than crashing, which is why the ordering is enforced at the one
  // place batches are built.
  usize lo = 0, hi = txns_.size();
  while (lo < hi) {
    const usize mid = lo + (hi - lo) / 2;
    if (txns_[mid].wall_clock_unix <= wall_clock_unix) lo = mid + 1;
    else hi = mid;
  }
  return lo == 0 ? 0 : static_cast<u32>(lo - 1);
}

void Store::rebuild_entity_index() {
  const usize n = entity_.size();
  entity_offset_.clear();
  entity_facts_.clear();

  if (n == 0) {
    entity_index_valid_ = true;
    return;
  }

  u32 max_entity = 0;
  for (const u32 e : entity_) max_entity = std::max(max_entity, e);

  // Counting sort into CSR. Count, prefix-sum, scatter — O(n + entities), two
  // passes, two allocations. Same offset-array idiom as the adjacency in
  // px/graph.hpp.
  entity_offset_.assign(static_cast<usize>(max_entity) + 2, 0u);
  for (const u32 e : entity_) ++entity_offset_[static_cast<usize>(e) + 1];
  for (usize i = 1; i < entity_offset_.size(); ++i) {
    entity_offset_[i] += entity_offset_[i - 1];
  }

  entity_facts_.resize(n);
  std::vector<u32> cursor(entity_offset_.begin(), entity_offset_.end() - 1);
  for (usize i = 0; i < n; ++i) {
    entity_facts_[cursor[entity_[i]]++] = static_cast<u32>(i);
  }

  entity_index_valid_ = true;
}

void Store::as_of_entity(EntityId entity, Timestamp valid_at, TxnId sys_at,
                         std::vector<FactId>& out, ScanStats* stats) const {
  // Falling back to a full scan when the index is stale keeps a missing
  // rebuild_entity_index() a performance problem rather than a wrong answer.
  if (!entity_index_valid_ || entity.index() + 1 >= entity_offset_.size()) {
    std::vector<FactId> all;
    as_of(valid_at, sys_at, all, stats);
    for (const FactId f : all) {
      if (entity_[f.index()] == entity.v) out.push_back(f);
    }
    return;
  }

  const u32 s = sys_at.v;
  const u32 begin = entity_offset_[entity.index()];
  const u32 end = entity_offset_[entity.index() + 1];

  ScanStats local{};
  local.chunks_total = 1;

  for (u32 k = begin; k < end; ++k) {
    const u32 i = entity_facts_[k];
    const int known_then =
        static_cast<int>(sys_from_[i] <= s) & static_cast<int>(s < sys_to_[i]);
    const int true_then = static_cast<int>(valid_from_[i] <= valid_at) &
                          static_cast<int>(valid_at < valid_to_[i]);
    if ((known_then & true_then) != 0) out.push_back(FactId{i});
  }

  local.rows_scanned = end - begin;
  local.rows_matched = static_cast<u32>(out.size());
  if (stats) *stats = local;
}

usize Store::heap_bytes() const noexcept {
  const usize rows = entity_.size();
  const usize columns = rows * (sizeof(u32) * 2 + sizeof(u64) + sizeof(u8) +
                                sizeof(Timestamp) * 2 + sizeof(u32) * 2 + sizeof(u16));
  const usize index = entity_offset_.size() * sizeof(u32) + entity_facts_.size() * sizeof(u32);
  const usize meta = chunks_.size() * sizeof(ChunkStats) + txns_.size() * sizeof(TxnInfo);
  return columns + index + meta + symbols_.bytes();
}

}  // namespace px
