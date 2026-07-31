// ── tests/test_graph.cpp ────────────────────────────────────────────────────
// CSR adjacency, k-hop, bidirectional shortest path, components and label
// propagation.
//
// These cases lived in test_er.cpp because entity resolution was the graph's
// only consumer. It is about to have others — the recon UI expands k-hop from a
// selected entity and paths between two — so they move to a file named after
// what they test.
// ────────────────────────────────────────────────────────────────────────────
#include <vector>

#include <doctest.h>

#include "px/graph.hpp"

using namespace px;

TEST_CASE("CSR round-trips an edge list as undirected adjacency") {
  Csr g;
  g.build({{0, 1}, {1, 2}, {2, 3}}, 4);

  CHECK(g.node_count() == 4);
  CHECK(g.edge_count() == 3);
  CHECK(g.degree(0) == 1);
  CHECK(g.degree(1) == 2);

  const auto nbs = g.neighbours(1);
  CHECK(nbs.size() == 2);
  CHECK(std::find(nbs.begin(), nbs.end(), 0u) != nbs.end());
  CHECK(std::find(nbs.begin(), nbs.end(), 2u) != nbs.end());
}

TEST_CASE("k-hop expands exactly k levels") {
  Csr g;
  g.build({{0, 1}, {1, 2}, {2, 3}, {3, 4}}, 5);

  std::vector<u32> out;
  g.k_hop(0, 1, out);
  CHECK(out.size() == 1);

  out.clear();
  g.k_hop(0, 2, out);
  CHECK(out.size() == 2);

  out.clear();
  g.k_hop(0, 10, out);
  CHECK(out.size() == 4);  // everything but the source
}

TEST_CASE("bidirectional shortest path finds a true shortest path") {
  Csr g;
  // A long chain plus a shortcut, so a wrong implementation returns the chain.
  g.build({{0, 1}, {1, 2}, {2, 3}, {3, 4}, {4, 5}, {0, 5}}, 6);

  std::vector<u32> path;
  g.shortest_path(0, 5, path);

  REQUIRE(path.size() == 2);  // the shortcut, not the 5-hop chain
  CHECK(path.front() == 0);
  CHECK(path.back() == 5);
}

TEST_CASE("shortest path handles trivial and disconnected cases") {
  Csr g;
  g.build({{0, 1}, {2, 3}}, 4);

  std::vector<u32> path;
  g.shortest_path(1, 1, path);
  CHECK(path.size() == 1);

  path.clear();
  g.shortest_path(0, 3, path);
  CHECK(path.empty());  // disconnected
}

TEST_CASE("shortest path is contiguous — every step is a real edge") {
  Csr g;
  g.build({{0, 1}, {1, 2}, {2, 3}, {3, 4}, {0, 9}, {9, 4}}, 10);

  std::vector<u32> path;
  g.shortest_path(0, 4, path);
  REQUIRE(path.size() >= 2);

  // The bug bidirectional search invites is stitching the two halves together
  // wrong, producing a "path" containing a jump that is not an edge.
  for (usize i = 1; i < path.size(); ++i) {
    const auto nbs = g.neighbours(path[i - 1]);
    INFO("step ", i, ": ", path[i - 1], " -> ", path[i]);
    CHECK(std::find(nbs.begin(), nbs.end(), path[i]) != nbs.end());
  }
}

TEST_CASE("components are exact") {
  Csr g;
  g.build({{0, 1}, {1, 2}, {5, 6}}, 8);

  std::vector<u32> comp;
  g.components(comp);

  CHECK(comp[0] == comp[1]);
  CHECK(comp[1] == comp[2]);
  CHECK(comp[5] == comp[6]);
  CHECK(comp[0] != comp[5]);
  CHECK(comp[3] != comp[4]);  // two isolated singletons
}

TEST_CASE("label propagation is deterministic across runs") {
  Csr g;
  g.build({{0, 1}, {1, 2}, {0, 2}, {3, 4}, {4, 5}, {3, 5}, {2, 3}}, 6);

  std::vector<u32> a, b;
  g.label_propagation(20, a);
  g.label_propagation(20, b);

  // Ties break to the lowest node id and updates are synchronous, so the
  // result cannot depend on neighbour ordering. Without that, community
  // colours flicker between runs and read as a bug even when the partition is
  // fine.
  CHECK(a == b);
  CHECK(a.size() == 6);
}
