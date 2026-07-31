#include "px/graph.hpp"

#include <algorithm>

namespace px {

namespace {

/// A flat bitset. std::vector<bool> is a proxy-reference container whose
/// operator[] does not return a real bool&, which is a footgun in generic
/// code; a u64 array is also ~8x denser and clears with one memset.
class Bitset {
 public:
  explicit Bitset(usize bits) : words_((bits + 63) / 64, 0) {}
  void set(u32 i) { words_[i >> 6] |= (u64{1} << (i & 63)); }
  [[nodiscard]] bool test(u32 i) const { return (words_[i >> 6] >> (i & 63)) & 1u; }
  void clear() { std::fill(words_.begin(), words_.end(), 0u); }

 private:
  std::vector<u64> words_;
};

}  // namespace

void Csr::build(const std::vector<Edge>& edges, u32 node_count) {
  node_count_ = node_count;
  offsets_.assign(static_cast<usize>(node_count) + 1, 0u);

  // Pass 1 — count degrees. Each undirected edge contributes to both ends.
  for (const Edge& e : edges) {
    if (e.from >= node_count || e.to >= node_count) continue;
    ++offsets_[e.from + 1];
    ++offsets_[e.to + 1];
  }

  // Pass 2 — prefix sum turns counts into start offsets.
  for (usize i = 1; i < offsets_.size(); ++i) offsets_[i] += offsets_[i - 1];

  const usize total = offsets_.back();
  targets_.resize(total);
  edge_ref_.resize(total);
  weight_.resize(total);

  // Pass 3 — scatter. `cursor` starts as a copy of the offsets and advances as
  // each node's slots fill.
  std::vector<u32> cursor(offsets_.begin(), offsets_.end() - 1);
  for (const Edge& e : edges) {
    if (e.from >= node_count || e.to >= node_count) continue;

    const u32 a = cursor[e.from]++;
    targets_[a] = e.to;
    edge_ref_[a] = e.ref;
    weight_[a] = e.weight;

    const u32 b = cursor[e.to]++;
    targets_[b] = e.from;
    edge_ref_[b] = e.ref;
    weight_[b] = e.weight;
  }
}

void Csr::k_hop(u32 source, u32 k, std::vector<u32>& out) const {
  if (source >= node_count_ || k == 0) return;

  Bitset visited(node_count_);
  visited.set(source);

  std::vector<u32> frontier{source};
  std::vector<u32> next;

  for (u32 depth = 0; depth < k && !frontier.empty(); ++depth) {
    next.clear();
    for (const u32 node : frontier) {
      for (const u32 nb : neighbours(node)) {
        if (visited.test(nb)) continue;
        visited.set(nb);
        next.push_back(nb);
        out.push_back(nb);
      }
    }
    frontier.swap(next);
  }
}

void Csr::shortest_path(u32 a, u32 b, std::vector<u32>& out) const {
  if (a >= node_count_ || b >= node_count_) return;
  if (a == b) {
    out.push_back(a);
    return;
  }

  // Parent pointers from each side. kUnreachable means "not seen from this
  // side"; a node is its own parent at the root.
  std::vector<u32> parent_a(node_count_, kUnreachable);
  std::vector<u32> parent_b(node_count_, kUnreachable);
  parent_a[a] = a;
  parent_b[b] = b;

  std::vector<u32> frontier_a{a};
  std::vector<u32> frontier_b{b};
  std::vector<u32> next;

  u32 meeting = kUnreachable;

  // Expand whichever frontier is SMALLER each round. That is what actually
  // delivers the b^(d/2) behaviour — alternating blindly can expand the wide
  // side repeatedly and give back most of the advantage.
  while (meeting == kUnreachable && !frontier_a.empty() && !frontier_b.empty()) {
    const bool expand_a = frontier_a.size() <= frontier_b.size();
    std::vector<u32>& frontier = expand_a ? frontier_a : frontier_b;
    std::vector<u32>& mine = expand_a ? parent_a : parent_b;
    const std::vector<u32>& theirs = expand_a ? parent_b : parent_a;

    next.clear();
    for (const u32 node : frontier) {
      for (const u32 nb : neighbours(node)) {
        if (mine[nb] != kUnreachable) continue;
        mine[nb] = node;
        if (theirs[nb] != kUnreachable) {
          meeting = nb;
          break;
        }
        next.push_back(nb);
      }
      if (meeting != kUnreachable) break;
    }
    frontier.swap(next);
  }

  if (meeting == kUnreachable) return;

  // Walk back to `a`, then forward to `b`.
  std::vector<u32> left;
  for (u32 n = meeting; n != a; n = parent_a[n]) left.push_back(n);
  left.push_back(a);
  std::reverse(left.begin(), left.end());

  out.insert(out.end(), left.begin(), left.end());

  // Guard on meeting != b.
  //
  // The classic bidirectional-BFS stitching bug: each search root is its own
  // parent, so when the frontiers meet AT the target, parent_b[meeting] is
  // meeting itself and the forward walk appends b a second time. A direct edge
  // 0-5 then returned [0, 5, 5] — the right length claim, a path containing a
  // self-step that is not an edge.
  //
  // The left half already ends at the meeting point, so when that point is b
  // there is nothing left to walk.
  if (meeting != b) {
    for (u32 n = parent_b[meeting]; ; n = parent_b[n]) {
      out.push_back(n);
      if (n == b) break;
    }
  }
}

void Csr::label_propagation(u32 iterations, std::vector<u32>& labels_out) const {
  labels_out.resize(node_count_);
  for (u32 i = 0; i < node_count_; ++i) labels_out[i] = i;

  std::vector<u32> next(labels_out);
  std::vector<std::pair<u32, u32>> tally;  // (label, count)

  for (u32 iter = 0; iter < iterations; ++iter) {
    bool changed = false;

    for (u32 node = 0; node < node_count_; ++node) {
      const Span<const u32> nbs = neighbours(node);
      if (nbs.empty()) continue;

      tally.clear();
      for (const u32 nb : nbs) {
        const u32 label = labels_out[nb];
        bool found = false;
        for (auto& [l, c] : tally) {
          if (l == label) {
            ++c;
            found = true;
            break;
          }
        }
        if (!found) tally.emplace_back(label, 1u);
      }

      // Most common label wins; ties break to the LOWEST label id. That
      // tie-break is what makes the result deterministic — without it the
      // answer depends on neighbour ordering and the community colours flicker
      // between runs, which reads as a bug even when the partition is fine.
      u32 best_label = labels_out[node];
      u32 best_count = 0;
      for (const auto& [l, c] : tally) {
        if (c > best_count || (c == best_count && l < best_label)) {
          best_label = l;
          best_count = c;
        }
      }

      next[node] = best_label;
      if (best_label != labels_out[node]) changed = true;
    }

    // Synchronous update: every node reads the PREVIOUS iteration's labels.
    // Asynchronous propagation converges faster but makes the result depend on
    // node order, which is the same determinism problem as the tie-break.
    labels_out.swap(next);
    if (!changed) break;
  }
}

void Csr::components(std::vector<u32>& component_out) const {
  component_out.assign(node_count_, kUnreachable);
  std::vector<u32> stack;

  u32 component = 0;
  for (u32 root = 0; root < node_count_; ++root) {
    if (component_out[root] != kUnreachable) continue;

    stack.clear();
    stack.push_back(root);
    component_out[root] = component;

    while (!stack.empty()) {
      const u32 node = stack.back();
      stack.pop_back();
      for (const u32 nb : neighbours(node)) {
        if (component_out[nb] != kUnreachable) continue;
        component_out[nb] = component;
        stack.push_back(nb);
      }
    }
    ++component;
  }
}

}  // namespace px
