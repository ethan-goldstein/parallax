// ── px/graph.hpp ────────────────────────────────────────────────────────────
// Compressed sparse row adjacency, and the traversals over it.
//
// CSR is two arrays: `offsets`, where node i owns targets[offsets[i] ..
// offsets[i+1]), and `targets` holding every neighbour back to back. Built by
// counting sort — count degrees, prefix-sum, scatter — which is O(n + m) in
// two passes and two allocations.
//
// This is the same jagged-offset idiom already in
// workflow/web/src/components/brain3d.ts (sprayStart / sprayBase / sprayCap),
// and the same one the bitemporal store uses for its entity index. Three
// structures, one layout: contiguous data plus an offset table beats pointer
// chasing every time, and it serialises to a snapshot with no fixups.
//
// `edge_ref` is the detail that is easy to omit and shouldn't be: it points
// back at the fact that created each edge, so the UI can answer "why is there
// an edge here?" with a source and a license rather than asking for trust.
// ────────────────────────────────────────────────────────────────────────────
#pragma once

#include <vector>

#include "px/ids.hpp"
#include "px/prelude.hpp"

namespace px {

constexpr u32 kUnreachable = 0xFFFF'FFFFu;

struct Edge {
  u32 from;
  u32 to;
  f32 weight = 1.0f;
  /// FactId that asserted this link — provenance for the edge itself.
  u32 ref = 0xFFFF'FFFFu;
};

class Csr {
 public:
  /// Builds from an edge list. Edges are treated as UNDIRECTED: each is
  /// scattered in both directions, because every relationship in this data
  /// (co-located, co-reported, resolved-to) is symmetric. A directed variant
  /// would need a second transposed structure to answer "who points at me".
  void build(const std::vector<Edge>& edges, u32 node_count);

  [[nodiscard]] u32 node_count() const noexcept { return node_count_; }
  [[nodiscard]] u32 edge_count() const noexcept {
    return static_cast<u32>(targets_.size()) / 2;
  }

  [[nodiscard]] u32 degree(u32 node) const noexcept {
    if (node + 1 >= offsets_.size()) return 0;
    return offsets_[node + 1] - offsets_[node];
  }

  [[nodiscard]] Span<const u32> neighbours(u32 node) const noexcept {
    if (node + 1 >= offsets_.size()) return {};
    return {targets_.data() + offsets_[node], degree(node)};
  }

  [[nodiscard]] Span<const u32> neighbour_refs(u32 node) const noexcept {
    if (node + 1 >= offsets_.size()) return {};
    return {edge_ref_.data() + offsets_[node], degree(node)};
  }

  [[nodiscard]] f32 edge_weight(u32 node, u32 slot) const noexcept {
    const u32 base = offsets_[node];
    return weight_[base + slot];
  }

  // ── traversals ───────────────────────────────────────────────────────────

  /// Nodes reachable from `source` within `k` hops, excluding the source.
  /// Double-buffered frontiers and a u64 visited bitset — no per-node
  /// allocation, no std::set.
  void k_hop(u32 source, u32 k, std::vector<u32>& out) const;

  /// Shortest unweighted path, searching from BOTH ends and stopping when the
  /// frontiers meet.
  ///
  /// Worth the extra bookkeeping: unidirectional BFS explores O(b^d) nodes
  /// while bidirectional explores O(2·b^(d/2)). On a graph with average degree
  /// 10 and a path of length 6, that is ~1,000,000 versus ~2,000 — the
  /// difference between an interaction that feels instant and one that hangs.
  ///
  /// Returns the node sequence including both endpoints, or empty if
  /// disconnected.
  void shortest_path(u32 a, u32 b, std::vector<u32>& out) const;

  /// Community labels by label propagation.
  ///
  /// Synchronous, with ties broken by lowest node id so the result is
  /// deterministic — an algorithm that returns different colours on every run
  /// makes a visualisation untrustworthy even when it is not wrong. ~50 lines,
  /// and the highest visual payoff per line in the project.
  ///
  /// Not Louvain: this does not optimise modularity and can merge weakly
  /// connected groups. Stated plainly rather than implied otherwise.
  void label_propagation(u32 iterations, std::vector<u32>& labels_out) const;

  /// Connected components via BFS. Exact, unlike label propagation.
  void components(std::vector<u32>& component_out) const;

 private:
  std::vector<u32> offsets_;
  std::vector<u32> targets_;
  std::vector<u32> edge_ref_;
  std::vector<f32> weight_;
  u32 node_count_ = 0;
};

}  // namespace px
