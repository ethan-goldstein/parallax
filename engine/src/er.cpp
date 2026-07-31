#include "px/er.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <unordered_map>
#include <unordered_set>

#include "px/bench.hpp"
#include "px/symbols.hpp"

namespace px::er {

const char* comparator_name(Comparator c) noexcept {
  switch (c) {
    case Comparator::ExactId: return "exact id";
    case Comparator::GeoDistance: return "distance";
    case Comparator::TimeDelta: return "origin time";
    case Comparator::MagnitudeDelta: return "magnitude";
    case Comparator::NameSimilarity: return "region name";
  }
  return "?";
}

// ── UnionFind ──────────────────────────────────────────────────────────────

UnionFind::UnionFind(u32 n) : parent_(n), rank_(n, 0) {
  for (u32 i = 0; i < n; ++i) parent_[i] = i;
}

u32 UnionFind::find(u32 x) {
  // Path halving: points each node at its grandparent as we walk. Same
  // near-constant amortised behaviour as full path compression, iterative, and
  // it does not need a second pass or recursion.
  while (parent_[x] != x) {
    parent_[x] = parent_[parent_[x]];
    x = parent_[x];
  }
  return x;
}

bool UnionFind::unite(u32 a, u32 b) {
  u32 ra = find(a);
  u32 rb = find(b);
  if (ra == rb) return false;

  // Union by rank keeps the tree shallow. Without it, a chain of merges
  // degenerates into a linked list and find() becomes O(n).
  if (rank_[ra] < rank_[rb]) std::swap(ra, rb);
  parent_[rb] = ra;
  if (rank_[ra] == rank_[rb]) ++rank_[ra];
  return true;
}

// ── Jaro-Winkler ───────────────────────────────────────────────────────────

f64 jaro_winkler(std::string_view a, std::string_view b) noexcept {
  if (a.empty() && b.empty()) return 1.0;
  if (a.empty() || b.empty()) return 0.0;
  if (a == b) return 1.0;

  const usize la = a.size(), lb = b.size();
  // Characters can only match within this window, which is what makes Jaro
  // tolerant of transposition without being tolerant of everything.
  const usize window = std::max(la, lb) / 2 > 0 ? std::max(la, lb) / 2 - 1 : 0;

  std::vector<u8> a_match(la, 0), b_match(lb, 0);
  usize matches = 0;

  for (usize i = 0; i < la; ++i) {
    const usize lo = i > window ? i - window : 0;
    const usize hi = std::min(i + window + 1, lb);
    for (usize j = lo; j < hi; ++j) {
      if (b_match[j] || a[i] != b[j]) continue;
      a_match[i] = 1;
      b_match[j] = 1;
      ++matches;
      break;
    }
  }
  if (matches == 0) return 0.0;

  usize transpositions = 0;
  for (usize i = 0, k = 0; i < la; ++i) {
    if (!a_match[i]) continue;
    while (!b_match[k]) ++k;
    if (a[i] != b[k]) ++transpositions;
    ++k;
  }

  const f64 m = static_cast<f64>(matches);
  const f64 jaro = (m / static_cast<f64>(la) + m / static_cast<f64>(lb) +
                    (m - static_cast<f64>(transpositions) / 2.0) / m) /
                   3.0;

  // Winkler's prefix bonus, capped at 4 characters. Place names that refer to
  // the same region overwhelmingly share a prefix.
  usize prefix = 0;
  while (prefix < 4 && prefix < la && prefix < lb && a[prefix] == b[prefix]) ++prefix;

  return jaro + static_cast<f64>(prefix) * 0.1 * (1.0 - jaro);
}

// ── scoring ────────────────────────────────────────────────────────────────

namespace {

std::string fmt(f64 v, int decimals = 2) {
  char buf[64];
  std::snprintf(buf, sizeof(buf), "%.*f", decimals, v);
  return buf;
}

Pair score_pair(const Record& a, const Record& b, const ErConfig& cfg,
                const SymbolTable* symbols) {
  Pair p;
  p.a = a.id;
  p.b = b.id;

  // 1. Exact external id. Rare across agencies but decisive when present.
  if (a.external_id.valid() && b.external_id.valid() && a.external_id == b.external_id) {
    const std::string text =
        symbols ? std::string(symbols->text(a.external_id)) : std::string("<id>");
    p.evidence.push_back(MatchEvidence{Comparator::ExactId, text, text, cfg.w_id_agree, true});
    p.score += cfg.w_id_agree;
  }

  // 2. Distance.
  const f64 dist = haversine_m(a.position.lat(), a.position.lon(), b.position.lat(),
                               b.position.lon());
  {
    const bool agree = dist <= cfg.geo_tolerance_m;
    // Contribution decays with distance rather than being a step function, so
    // a pair 5 km apart scores above one 90 km apart. A hard threshold throws
    // away exactly the information that separates a confident merge from a
    // marginal one.
    const f64 closeness = 1.0 - std::min(dist / cfg.geo_tolerance_m, 1.0);
    const f64 contribution = agree ? cfg.w_geo_agree * (0.4 + 0.6 * closeness)
                                   : cfg.w_geo_disagree;
    p.evidence.push_back(MatchEvidence{Comparator::GeoDistance, fmt(dist / 1000.0, 1) + " km",
                                       fmt(0.0, 0) + " km ref", contribution, agree});
    p.evidence.back().a_value = fmt(dist / 1000.0, 1) + " km apart";
    p.evidence.back().b_value = "tolerance " + fmt(cfg.geo_tolerance_m / 1000.0, 0) + " km";
    p.score += contribution;
  }

  // 3. Origin time.
  {
    const f64 dt = std::fabs(static_cast<f64>(a.time) - static_cast<f64>(b.time));
    const bool agree = dt <= cfg.time_tolerance_s;
    const f64 closeness = 1.0 - std::min(dt / cfg.time_tolerance_s, 1.0);
    const f64 contribution = agree ? cfg.w_time_agree * (0.4 + 0.6 * closeness)
                                   : cfg.w_time_disagree;
    p.evidence.push_back(MatchEvidence{Comparator::TimeDelta, fmt(dt, 0) + " s apart",
                                       "tolerance " + fmt(cfg.time_tolerance_s, 0) + " s",
                                       contribution, agree});
    p.score += contribution;
  }

  // 4. Magnitude, when both sides report one.
  if (a.has_magnitude && b.has_magnitude) {
    const f64 dm = std::fabs(a.magnitude - b.magnitude);
    const bool agree = dm <= cfg.magnitude_tolerance;
    p.evidence.push_back(MatchEvidence{Comparator::MagnitudeDelta, fmt(a.magnitude, 1),
                                       fmt(b.magnitude, 1),
                                       agree ? cfg.w_mag_agree : cfg.w_mag_disagree, agree});
    p.score += agree ? cfg.w_mag_agree : cfg.w_mag_disagree;
  }

  // 5. Region label.
  if (symbols != nullptr && a.label.valid() && b.label.valid()) {
    const std::string_view la = symbols->text(a.label);
    const std::string_view lb = symbols->text(b.label);
    if (!la.empty() && !lb.empty()) {
      const f64 sim = jaro_winkler(la, lb);
      const bool agree = sim >= 0.75;
      p.evidence.push_back(MatchEvidence{Comparator::NameSimilarity, std::string(la),
                                         std::string(lb),
                                         agree ? cfg.w_name_agree * sim : cfg.w_name_disagree,
                                         agree});
      p.score += agree ? cfg.w_name_agree * sim : cfg.w_name_disagree;
    }
  }

  p.accepted = p.score >= cfg.threshold;
  return p;
}

}  // namespace

// ── resolve ────────────────────────────────────────────────────────────────

Resolution resolve(const std::vector<Record>& records, const ErConfig& cfg,
                   const SymbolTable* symbols) {
  Resolution res;
  ScopedTimer timer(res.stats.elapsed_ms);

  const u32 n = static_cast<u32>(records.size());
  res.stats.records = n;
  if (n == 0) return res;

  // ── 1. BLOCKING ──────────────────────────────────────────────────────────
  //
  // Two key families, unioned:
  //   geo   — a coarse Morton cell. Free: the spatial index already computes
  //           these keys, and masking low bits gives a ~1 degree cell.
  //   time  — a coarse time bucket, so two reports of one quake collide even
  //           if they landed either side of a cell boundary.
  //
  // Independent families matter: a pair only has to share ONE key to be
  // compared, so a boundary miss in one family is covered by the other.
  std::unordered_map<u64, std::vector<u32>> blocks;
  const MortonKey mask = ~MortonKey{0} << cfg.block_level;

  for (u32 i = 0; i < n; ++i) {
    const MortonKey cell = morton_of(records[i].position) & mask;
    blocks[cell].push_back(i);

    // 600-second buckets, tagged so time keys cannot collide with geo keys.
    //
    // The tag is a typed u64 constant rather than a `ull` literal. On Linux
    // u64 is `unsigned long` while a ull literal is `unsigned long long` —
    // distinct types even at identical width — so mixing them trips
    // -Wsign-conversion under GCC while compiling cleanly under Apple clang,
    // where u64 already IS unsigned long long. Constructing the constant at
    // the alias type is correct on both.
    constexpr u64 kTimeKeyTag = u64{0x7000'0000'0000'0000};
    const u64 bucket = static_cast<u64>(static_cast<i64>(records[i].time) / 600);
    blocks[kTimeKeyTag | bucket].push_back(i);
  }
  res.stats.blocks = static_cast<u32>(blocks.size());

  // ── 2. SCORING ───────────────────────────────────────────────────────────
  UnionFind uf(n);
  // Deduplicate pairs: a pair sharing both a geo and a time key would
  // otherwise be scored twice and appear twice in the evidence list.
  //
  // A hash set, NOT a sorted vector with std::find. The first version was a
  // linear scan over a growing vector, which makes the whole pass quadratic in
  // the number of candidate pairs — it measured 4.0 SECONDS for 30k records in
  // the benchmark, and the cost was entirely in this lookup rather than in any
  // of the scoring. Constant-time membership is the difference between
  // resolution being interactive and being a batch job.
  std::unordered_set<u64> seen;
  seen.reserve(static_cast<usize>(n) * 4);

  for (auto& [key, bucket] : blocks) {
    if (bucket.size() < 2) continue;

    // Oversized blocks are quadratic. Cap them — but COUNT the skips, because
    // silently dropping comparisons means silently missing merges, and a
    // resolution that quietly under-merges looks identical to one that had
    // nothing to merge.
    if (bucket.size() > cfg.max_block_size) {
      ++res.stats.blocks_skipped;
      continue;
    }

    for (usize i = 0; i < bucket.size(); ++i) {
      for (usize j = i + 1; j < bucket.size(); ++j) {
        const u32 a = std::min(bucket[i], bucket[j]);
        const u32 b = std::max(bucket[i], bucket[j]);

        // Same-source pairs are false positives by construction: the agency
        // already resolved its own catalogue, so two distinct USGS ids are two
        // distinct quakes.
        if (cfg.cross_source_only && records[a].source == records[b].source) continue;

        const u64 pair_key = (static_cast<u64>(a) << 32) | b;
        if (!seen.insert(pair_key).second) continue;

        Pair p = score_pair(records[a], records[b], cfg, symbols);
        p.a = a;
        p.b = b;
        ++res.stats.pairs_compared;

        if (p.accepted) {
          uf.unite(a, b);
          res.accepted.push_back(p);
          ++res.stats.pairs_accepted;
        }
        res.all_pairs.push_back(std::move(p));
      }
    }
  }

  // ── 3. CLUSTERING ────────────────────────────────────────────────────────
  // Union-find roots are sparse; renumber them densely so cluster ids index
  // directly into `members`.
  res.cluster_of.assign(n, 0u);
  std::unordered_map<u32, u32> dense;
  for (u32 i = 0; i < n; ++i) {
    const u32 root = uf.find(i);
    auto it = dense.find(root);
    if (it == dense.end()) {
      const u32 id = static_cast<u32>(res.members.size());
      dense.emplace(root, id);
      res.members.emplace_back();
      res.cluster_of[i] = id;
      res.members[id].push_back(i);
    } else {
      res.cluster_of[i] = it->second;
      res.members[it->second].push_back(i);
    }
  }

  res.stats.clusters = static_cast<u32>(res.members.size());
  for (const auto& m : res.members) {
    if (m.size() > 1) res.stats.merged_records += static_cast<u32>(m.size());
  }

  return res;
}

// ── unmerge ────────────────────────────────────────────────────────────────

void unmerge(Resolution& res, u32 pair_index) {
  if (pair_index >= res.accepted.size()) return;

  // Union-find cannot undo a union, so the accepted edge list is replayed
  // without the removed edge. Rebuilding globally would be O(n·α); in practice
  // the component is small, and this keeps the code obviously correct rather
  // than clever.
  res.accepted.erase(res.accepted.begin() + pair_index);

  const u32 n = static_cast<u32>(res.cluster_of.size());
  UnionFind uf(n);
  for (const Pair& p : res.accepted) uf.unite(p.a, p.b);

  res.members.clear();
  std::unordered_map<u32, u32> dense;
  for (u32 i = 0; i < n; ++i) {
    const u32 root = uf.find(i);
    auto it = dense.find(root);
    if (it == dense.end()) {
      const u32 id = static_cast<u32>(res.members.size());
      dense.emplace(root, id);
      res.members.emplace_back();
      res.cluster_of[i] = id;
      res.members[id].push_back(i);
    } else {
      res.cluster_of[i] = it->second;
      res.members[it->second].push_back(i);
    }
  }

  res.stats.clusters = static_cast<u32>(res.members.size());
  res.stats.pairs_accepted = static_cast<u32>(res.accepted.size());
  res.stats.merged_records = 0;
  for (const auto& m : res.members) {
    if (m.size() > 1) res.stats.merged_records += static_cast<u32>(m.size());
  }
}

}  // namespace px::er
