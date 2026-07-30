// ── px/symbols.hpp ──────────────────────────────────────────────────────────
// String interning: every distinct string in the engine is stored once and
// referred to by a 4-byte SymbolId.
//
// This is dictionary encoding, and it pays for itself three times over:
//   - a string-valued attribute costs 4 bytes per fact, not 8 + heap
//   - string equality becomes an integer compare
//   - the snapshot format serialises the character blob once, and SymbolIds
//     need no fixup on load because they are offsets, not pointers
//
// LIFETIME HAZARD, stated plainly because it is the one sharp edge here:
// text() returns a string_view INTO the character blob, and interning a new
// string can reallocate that blob. A view taken before an intern() call may
// dangle after it.
//
// The rule: never hold a string_view across an intern(). Copy the SymbolId
// instead — that is what it is for. reserve_chars() up front makes
// reallocation rare, but rare is not never, and the tests deliberately force
// growth to prove the rule matters.
// ────────────────────────────────────────────────────────────────────────────
#pragma once

#include <string_view>
#include <vector>

#include "px/ids.hpp"
#include "px/prelude.hpp"

namespace px {

class SymbolTable {
 public:
  SymbolTable();

  /// Interns `s`, returning a stable id. Interning the same text twice returns
  /// the same id — that is the whole contract.
  ///
  /// The empty string is always SymbolId{0}, which makes "absent" and "empty"
  /// the same value and saves a branch at every call site that would otherwise
  /// need to distinguish them.
  SymbolId intern(std::string_view s);

  /// Looks up without interning. Returns an invalid id if absent — useful for
  /// query planning, where a filter on a string that appears nowhere in the
  /// data can be answered as "zero rows" without touching the store.
  [[nodiscard]] SymbolId find(std::string_view s) const noexcept;

  /// See the lifetime hazard above.
  [[nodiscard]] std::string_view text(SymbolId id) const noexcept;

  [[nodiscard]] usize size() const noexcept { return offset_.size(); }
  [[nodiscard]] usize bytes() const noexcept { return chars_.size(); }

  /// Pre-sizes the character blob. Worth calling with a real estimate before a
  /// bulk ingest.
  void reserve_chars(usize bytes);
  void reserve_symbols(usize count);

  /// Exposed for the snapshot writer, which memcpy's these directly.
  [[nodiscard]] Span<const char> char_blob() const noexcept { return {chars_.data(), chars_.size()}; }
  [[nodiscard]] Span<const u32> offsets() const noexcept { return {offset_.data(), offset_.size()}; }
  [[nodiscard]] Span<const u32> lengths() const noexcept { return {length_.data(), length_.size()}; }

 private:
  void rehash(usize new_bucket_count);
  [[nodiscard]] bool equals_at(u32 idx, std::string_view s) const noexcept;

  // All strings back to back in one allocation. Not null-terminated: lengths
  // are stored separately, so a string containing a NUL byte round-trips
  // correctly rather than being silently truncated.
  std::vector<char> chars_;
  std::vector<u32> offset_;  // SymbolId -> start in chars_
  std::vector<u32> length_;  // SymbolId -> byte length

  // Open addressing with linear probing. Power-of-two capacity so the modulo
  // is a mask. Stores SymbolId + 1, so a zero slot means empty and no separate
  // occupancy bitmap is needed.
  std::vector<u32> buckets_;
  usize occupied_ = 0;
};

/// FNV-1a. Chosen for being four lines and dependency-free rather than for
/// speed; the hash is not on any measured hot path, and if it ever becomes one
/// the replacement is a localised change behind this function.
[[nodiscard]] constexpr u64 fnv1a(std::string_view s) noexcept {
  u64 h = 0xcbf2'9ce4'8422'2325ull;
  for (const char c : s) {
    h ^= static_cast<u64>(static_cast<u8>(c));
    h *= 0x0000'0100'0000'01b3ull;
  }
  return h;
}

}  // namespace px
