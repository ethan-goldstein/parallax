// ── px/er.hpp ───────────────────────────────────────────────────────────────
// Entity resolution: deciding that two records describe the same real-world
// thing.
//
// The concrete problem here is real rather than manufactured. USGS and EMSC
// independently report the same earthquakes, minutes apart, with different
// coordinates (their networks triangulate differently), different magnitudes
// (different scales and revision schedules), and different event ids. Nothing
// joins them. Deciding "these are one quake" is exactly the problem, and it is
// the same shape as the one Palantir sells.
//
// ── the three stages ───────────────────────────────────────────────────────
//
// 1. BLOCKING — comparing every pair is O(n²): 3,500 records is 6.1 million
//    comparisons. Blocking groups records by cheap keys and only compares
//    within a group, on the bet that true duplicates share at least one key.
//
// 2. SCORING — Fellegi-Sunter log-odds. Each field agreeing adds
//    log(m/u), each disagreeing adds log((1-m)/(1-u)), where m is the
//    probability of agreement given a true match and u given a non-match. Sum
//    the field contributions; above a threshold, it is a match.
//
// 3. CLUSTERING — union-find over accepted pairs, so A~B and B~C makes one
//    entity of three records rather than two overlapping pairs.
//
// ── the evidence is the product ────────────────────────────────────────────
//
// Every comparison emits a MatchEvidence row: which field, which comparator,
// both values, and the signed contribution. That is not instrumentation added
// for debugging — it is the deliverable. A merge you cannot explain is a merge
// an analyst cannot defend, and an unexplainable merge in an intelligence
// system is worse than no merge at all.
//
// ── what this is NOT ───────────────────────────────────────────────────────
//
// The m and u probabilities are HAND-TUNED from a config table, not estimated
// by expectation-maximisation over the data. EM is the textbook approach and
// it is not implemented. Saying so is better than implying a trained model:
// a hand-tuned model you are candid about reads as engineering judgement,
// while an unexplained one reads as cargo cult.
// ────────────────────────────────────────────────────────────────────────────
#pragma once

#include <string>
#include <string_view>
#include <vector>

#include "px/geo.hpp"
#include "px/ids.hpp"
#include "px/prelude.hpp"
#include "px/symbols.hpp"
#include "px/value.hpp"

namespace px::er {

/// One record entering resolution: a source's assertion about something.
struct Record {
  u32 id = 0;
  u16 source = 0;
  GeoPoint position{};
  Timestamp time = 0;
  f64 magnitude = 0.0;
  bool has_magnitude = false;
  /// Interned identifier, when the source publishes a stable one.
  SymbolId external_id{};
  /// Interned free-text label — "SOUTHERN ITALY", "10 km SW of Anchorage".
  SymbolId label{};
};

enum class Comparator : u8 {
  ExactId,
  GeoDistance,
  TimeDelta,
  MagnitudeDelta,
  NameSimilarity,
};

[[nodiscard]] const char* comparator_name(Comparator c) noexcept;

/// One field's contribution to one pair's score. This is the row the UI draws
/// as a signed bar.
struct MatchEvidence {
  Comparator comparator{};
  /// Human-readable values from each side, already formatted.
  std::string a_value;
  std::string b_value;
  /// Log-odds contribution. Positive supports the match, negative opposes it.
  f64 contribution = 0.0;
  bool agreed = false;
};

/// A scored candidate pair.
struct Pair {
  u32 a = 0;
  u32 b = 0;
  f64 score = 0.0;
  bool accepted = false;
  std::vector<MatchEvidence> evidence;
};

/// Tunable model. Every number is a judgement call, and each carries the
/// reasoning that produced it.
struct ErConfig {
  /// Two reports of the same quake rarely agree within 30 km — different
  /// seismic networks triangulate from different station geometry.
  f64 geo_tolerance_m = 100'000.0;
  /// Origin times agree closely; the networks are solving for the same rupture.
  f64 time_tolerance_s = 90.0;
  /// Magnitude scales differ (ml vs mb vs mw), so half a unit is agreement.
  f64 magnitude_tolerance = 0.7;

  /// Log-odds weights. Positive on agreement, negative on disagreement.
  ///
  /// Geo and time dominate because they are physical measurements of the same
  /// event; magnitude is weaker because the scales genuinely differ; name
  /// similarity is weakest because region labels are free text from different
  /// gazetteers.
  f64 w_geo_agree = 3.2, w_geo_disagree = -4.0;
  f64 w_time_agree = 3.0, w_time_disagree = -5.0;
  f64 w_mag_agree = 1.1, w_mag_disagree = -0.8;
  f64 w_name_agree = 0.7, w_name_disagree = -0.1;
  /// An exact shared external id is near-decisive on its own.
  f64 w_id_agree = 8.0;

  /// Accept above this. Chosen so that geo AND time agreeing (6.2) clears it
  /// but geo alone (3.2) does not — no single field can force a merge.
  f64 threshold = 5.0;

  /// Records sharing a blocking key are compared pairwise, so one oversized
  /// block is quadratic. Capping is the right call; SILENTLY capping is not,
  /// which is why skipped blocks are counted and reported.
  u32 max_block_size = 200;

  /// Coarse Morton level for the geographic blocking key. ~40 bits masked is
  /// roughly a degree, comfortably wider than geo_tolerance_m.
  u32 block_level = 40;

  /// Records from the SAME source are never merged. Two distinct USGS event
  /// ids are two distinct quakes by construction — the agency already resolved
  /// them — so a same-source pair is a false positive by definition.
  bool cross_source_only = true;
};

struct ErStats {
  u32 records = 0;
  u32 blocks = 0;
  u32 blocks_skipped = 0;
  u32 pairs_compared = 0;
  u32 pairs_accepted = 0;
  u32 clusters = 0;
  /// Records that merged with at least one other.
  u32 merged_records = 0;
  f64 elapsed_ms = 0.0;
};

/// Union-find with path compression and union by rank.
class UnionFind {
 public:
  explicit UnionFind(u32 n);
  u32 find(u32 x);
  bool unite(u32 a, u32 b);
  [[nodiscard]] u32 size() const noexcept { return static_cast<u32>(parent_.size()); }

 private:
  std::vector<u32> parent_;
  std::vector<u8> rank_;
};

/// Result of a resolution pass.
struct Resolution {
  /// record index -> canonical cluster id (dense, 0..cluster_count).
  std::vector<u32> cluster_of;
  /// cluster id -> member record indices.
  std::vector<std::vector<u32>> members;
  /// Accepted pairs, retained so a merge can be UNDONE.
  ///
  /// Union-find cannot un-merge — that is its known weakness and hand-waving
  /// it is the obvious failure. Keeping the edge list means un-merging is:
  /// drop the edge, rebuild union-find over that component's remaining edges.
  /// Components are small, so this is microseconds.
  std::vector<Pair> accepted;
  /// Every pair that was scored, accepted or not. Rejected pairs are as
  /// informative as accepted ones when auditing a model.
  std::vector<Pair> all_pairs;
  ErStats stats;
};

/// Jaro-Winkler similarity in [0, 1]. Chosen over Levenshtein for short
/// proper nouns: it rewards a shared prefix, which is how place names differ
/// ("SOUTHERN ITALY" vs "SOUTHERN ITALY, TYRRHENIAN SEA").
[[nodiscard]] f64 jaro_winkler(std::string_view a, std::string_view b) noexcept;

/// Runs blocking, scoring, and clustering.
///
/// `symbols` resolves interned labels for the name comparator; pass nullptr to
/// skip that field entirely.
///
/// Note the parameter type is px::SymbolTable, spelled without an elaborated
/// `class` specifier on purpose. Writing `const class SymbolTable*` here would
/// DECLARE a new type px::er::SymbolTable rather than referring to the outer
/// one — the name would then be ambiguous to any translation unit that opens
/// both namespaces, and the definition would be incomplete inside this file.
[[nodiscard]] Resolution resolve(const std::vector<Record>& records, const ErConfig& cfg,
                                 const SymbolTable* symbols = nullptr);

/// Removes one accepted pair and recomputes the affected cluster only.
void unmerge(Resolution& res, u32 pair_index);

}  // namespace px::er
