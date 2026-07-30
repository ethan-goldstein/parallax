#include "px/store.hpp"

#include <algorithm>

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

void Store::as_of(Timestamp valid_at, TxnId sys_at, std::vector<FactId>& out,
                  ScanStats* stats) const {
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

    // The visibility predicate. Written scalar and branch-free: all four
    // operands are 32-bit, so this is the loop that -msimd128 vectorises and
    // the one the SIMD pass in Phase 8 rewrites by hand. Both versions must
    // agree with the reference store.
    for (u32 i = begin; i < end; ++i) {
      // Bitwise & on deliberately int-ified comparisons, not &&. Short-circuit
      // would introduce a data-dependent branch per row, and at ~50% match
      // rates the branch predictor cannot help — the mispredicts cost more
      // than evaluating both sides always. Casting to int also states the
      // intent explicitly, which is what -Wbitwise-instead-of-logical asks for.
      const int known_then =
          static_cast<int>(sys_from_[i] <= s) & static_cast<int>(s < sys_to_[i]);
      const int true_then = static_cast<int>(valid_from_[i] <= valid_at) &
                            static_cast<int>(valid_at < valid_to_[i]);
      if ((known_then & true_then) != 0) out.push_back(FactId{i});
    }

    local.rows_scanned += end - begin;
  }

  local.rows_matched = static_cast<u32>(out.size());
  if (stats) *stats = local;
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
  // passes, two allocations. Structurally the same offset-array idiom as
  // sprayStart/sprayBase in brain3d.ts.
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
