// ── px/ids.hpp ──────────────────────────────────────────────────────────────
// Strongly typed 32-bit handles.
//
// THE RULE THIS FILE EXISTS TO ENFORCE, and the single most important
// convention in the engine:
//
//     Never hold a pointer or reference into a container that can grow.
//     Hold an index.
//
// Every cross-structure reference in PARALLAX is an Id. That removes the
// entire class of "I kept a reference across a push_back and it silently
// pointed at freed memory" bugs — which is the most common way a C++ codebase
// this container-heavy produces wrong answers instead of crashes.
//
// It is also the faster choice, which is why it costs nothing to adopt: 4
// bytes instead of 8, denser in cache, and serialisable into a snapshot with
// no pointer fixups on load.
//
// The phantom Tag parameter makes the types distinct, so passing an EntityId
// where a NodeId belongs is a compile error rather than a three-hour debugging
// session over plausible-looking wrong output.
// ────────────────────────────────────────────────────────────────────────────
#pragma once

#include "px/prelude.hpp"

namespace px {

template <class Tag>
struct Id {
  static constexpr u32 kInvalid = 0xFFFF'FFFFu;

  u32 v = kInvalid;

  constexpr Id() noexcept = default;
  explicit constexpr Id(u32 value) noexcept : v(value) {}

  [[nodiscard]] constexpr bool valid() const noexcept { return v != kInvalid; }
  [[nodiscard]] constexpr usize index() const noexcept { return static_cast<usize>(v); }

  friend constexpr bool operator==(Id a, Id b) noexcept { return a.v == b.v; }
  friend constexpr bool operator!=(Id a, Id b) noexcept { return a.v != b.v; }
  friend constexpr bool operator<(Id a, Id b) noexcept { return a.v < b.v; }
};

struct EntityTag;
struct RecordTag;
struct SymbolTag;
struct FactTag;
struct TxnTag;
struct SourceTag;
struct NodeTag;

/// A resolved real-world thing: this vessel, this earthquake, this port.
using EntityId = Id<EntityTag>;

/// One source's assertion about a thing, before entity resolution decides
/// which EntityId it belongs to.
using RecordId = Id<RecordTag>;

/// An interned string.
using SymbolId = Id<SymbolTag>;

/// A row in the fact store.
using FactId = Id<FactTag>;

/// One ingest batch. This is the engine's notion of system time — see
/// px/store.hpp for why it is a counter and not a clock reading.
using TxnId = Id<TxnTag>;

/// A data source, carrying its license and attribution.
using SourceId = Id<SourceTag>;

/// A vertex in the CSR graph.
using NodeId = Id<NodeTag>;

}  // namespace px
