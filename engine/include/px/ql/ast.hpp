// ── px/ql/ast.hpp ───────────────────────────────────────────────────────────
// Flat AST: a std::vector<Node> with u32 child indices, not a pointer tree.
//
// Three reasons, in ascending order of how much they matter:
//   1. No allocation churn — one vector, grown once.
//   2. Trivially serialisable for the EXPLAIN viewer, since indices survive a
//      memcpy while pointers do not.
//   3. It dodges the ownership question entirely. A unique_ptr tree in a
//      codebase compiled with -fno-exceptions would need careful handling on
//      every partial-parse failure path; indices into a vector that owns
//      everything have no failure path at all.
//
// This is the same index-not-pointer rule as px/ids.hpp, applied to a tree.
// ────────────────────────────────────────────────────────────────────────────
#pragma once

#include <string>
#include <vector>

#include "px/prelude.hpp"

namespace px::ql {

constexpr u32 kNoNode = 0xFFFF'FFFFu;

enum class NodeKind : u8 {
  // expression nodes
  And,
  Or,
  Not,
  Compare,   // field <op> literal
  FieldRef,
  LitNumber,
  LitString,
  LitPredicate,  // country:RU
};

enum class CmpOp : u8 { Eq, NotEq, Lt, LtEq, Gt, GtEq, Contains };

struct Node {
  NodeKind kind{};
  CmpOp op{};
  u32 lhs = kNoNode;
  u32 rhs = kNoNode;
  f64 number = 0.0;
  /// Index into Query::strings for identifiers and literals.
  u32 str = kNoNode;
  /// Byte span in the source, for error highlighting and EXPLAIN.
  u32 begin = 0;
  u32 end = 0;
};

enum class DistanceUnit : u8 { Metres, Kilometres, NauticalMiles };

struct WithinClause {
  bool present = false;
  f64 distance_m = 0.0;
  /// Either an explicit coordinate...
  bool has_point = false;
  f64 lat = 0.0;
  f64 lon = 0.0;
  /// ...or a named place predicate, e.g. port:SGSIN, resolved at plan time.
  u32 place_key = kNoNode;
  u32 place_value = kNoNode;
};

struct BBoxClause {
  bool present = false;
  f64 min_lat = 0, min_lon = 0, max_lat = 0, max_lon = 0;
};

struct TemporalClause {
  bool present = false;
  /// Relative offsets are stored as seconds BEFORE the query's reference time,
  /// and resolved against it at plan time. Storing an absolute instant here
  /// would bake in the moment the query was parsed, so a saved query would
  /// silently mean something different tomorrow.
  bool relative = false;
  i64 relative_seconds = 0;
  i64 absolute_unix = 0;
};

struct AsOfClause {
  bool present = false;
  TemporalClause valid;
  TemporalClause system;  // the part after '@'
};

/// A parsed query. Owns its AST arena and its string table.
struct Query {
  /// Object type being queried: "earthquakes", "vessels", ...
  std::string source;

  std::vector<Node> nodes;
  std::vector<std::string> strings;

  u32 filter_root = kNoNode;
  WithinClause within;
  BBoxClause bbox;
  TemporalClause since;
  AsOfClause as_of;

  u32 limit = 0;  // 0 means unlimited
  std::string order_by;
  bool order_desc = false;

  [[nodiscard]] const std::string& str(u32 i) const {
    static const std::string kEmpty;
    return i < strings.size() ? strings[i] : kEmpty;
  }
};

/// A parse failure, with the span needed to underline it.
struct ParseError {
  bool failed = false;
  std::string message;
  u32 begin = 0;
  u32 end = 0;
};

}  // namespace px::ql
