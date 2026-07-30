#include "px/symbols.hpp"

#include <cstring>

namespace px {

namespace {
// Grow at 70% load. Linear probing degrades sharply past ~0.75, and the table
// is small enough that the memory saved by running hotter is not worth it.
constexpr usize kInitialBuckets = 1024;
constexpr usize kLoadNumerator = 7;
constexpr usize kLoadDenominator = 10;
}  // namespace

SymbolTable::SymbolTable() {
  buckets_.assign(kInitialBuckets, 0u);

  // Intern the empty string so it lands at SymbolId{0}. Callers can then treat
  // a default-constructed-to-zero symbol as "empty" without a special case.
  chars_.reserve(4096);
  offset_.push_back(0u);
  length_.push_back(0u);
  // Deliberately not inserted into buckets_: an empty-string lookup is handled
  // by the early return in find(), so it never probes.
}

void SymbolTable::reserve_chars(usize bytes) {
  chars_.reserve(bytes);
}

void SymbolTable::reserve_symbols(usize count) {
  offset_.reserve(count);
  length_.reserve(count);
  usize want = kInitialBuckets;
  while (want * kLoadNumerator / kLoadDenominator < count) want <<= 1;
  if (want > buckets_.size()) rehash(want);
}

bool SymbolTable::equals_at(u32 idx, std::string_view s) const noexcept {
  const usize i = static_cast<usize>(idx);
  if (static_cast<usize>(length_[i]) != s.size()) return false;
  if (s.empty()) return true;
  return std::memcmp(chars_.data() + offset_[i], s.data(), s.size()) == 0;
}

SymbolId SymbolTable::find(std::string_view s) const noexcept {
  if (s.empty()) return SymbolId{0};
  if (buckets_.empty()) return SymbolId{};

  const usize mask = buckets_.size() - 1;
  usize slot = static_cast<usize>(fnv1a(s)) & mask;

  // Terminates because the table is never full: rehash() runs at 70% load, so
  // an empty slot always exists to stop the probe.
  for (;;) {
    const u32 packed = buckets_[slot];
    if (packed == 0) return SymbolId{};
    const u32 idx = packed - 1;
    if (equals_at(idx, s)) return SymbolId{idx};
    slot = (slot + 1) & mask;
  }
}

SymbolId SymbolTable::intern(std::string_view s) {
  if (s.empty()) return SymbolId{0};

  if (const SymbolId existing = find(s); existing.valid()) return existing;

  if ((occupied_ + 1) * kLoadDenominator >= buckets_.size() * kLoadNumerator) {
    rehash(buckets_.size() << 1);
  }

  const u32 idx = static_cast<u32>(offset_.size());
  const u32 start = static_cast<u32>(chars_.size());

  // This insert is what can reallocate chars_ and invalidate every outstanding
  // string_view from text(). See the header.
  chars_.insert(chars_.end(), s.begin(), s.end());
  offset_.push_back(start);
  length_.push_back(static_cast<u32>(s.size()));

  const usize mask = buckets_.size() - 1;
  usize slot = static_cast<usize>(fnv1a(s)) & mask;
  while (buckets_[slot] != 0) slot = (slot + 1) & mask;
  buckets_[slot] = idx + 1;
  ++occupied_;

  return SymbolId{idx};
}

void SymbolTable::rehash(usize new_bucket_count) {
  PX_ASSERT((new_bucket_count & (new_bucket_count - 1)) == 0,
            "bucket count must be a power of two");

  std::vector<u32> next(new_bucket_count, 0u);
  const usize mask = new_bucket_count - 1;

  // Start at 1: SymbolId{0} is the empty string and is never bucketed.
  for (usize i = 1; i < offset_.size(); ++i) {
    const std::string_view s{chars_.data() + offset_[i], length_[i]};
    usize slot = static_cast<usize>(fnv1a(s)) & mask;
    while (next[slot] != 0) slot = (slot + 1) & mask;
    next[slot] = static_cast<u32>(i) + 1;
  }

  buckets_.swap(next);
}

std::string_view SymbolTable::text(SymbolId id) const noexcept {
  if (!id.valid() || id.index() >= offset_.size()) return {};
  const usize i = id.index();
  if (length_[i] == 0) return {};
  return std::string_view{chars_.data() + offset_[i], length_[i]};
}

}  // namespace px
