#include "px/ql/parser.hpp"

#include <cmath>
#include <string>

#include "px/ql/lexer.hpp"

namespace px::ql {

namespace {

class Parser {
 public:
  Parser(std::string_view src, std::vector<Token> toks)
      : src_(src), toks_(std::move(toks)) {}

  ParseResult run() {
    parse_query();
    ParseResult r;
    r.query = std::move(q_);
    r.error = std::move(err_);
    return r;
  }

 private:
  // ── token helpers ────────────────────────────────────────────────────────

  const Token& peek(usize ahead = 0) const {
    const usize i = pos_ + ahead;
    return i < toks_.size() ? toks_[i] : toks_.back();
  }
  const Token& advance() {
    const Token& t = peek();
    if (pos_ + 1 < toks_.size()) ++pos_;
    return t;
  }
  bool at_end() const { return peek().kind == Tok::End; }
  std::string_view text_of(const Token& t) const { return t.text(src_); }

  bool at_keyword(std::string_view kw) const {
    const Token& t = peek();
    return t.kind == Tok::Ident && iequals(text_of(t), kw);
  }
  bool eat_keyword(std::string_view kw) {
    if (!at_keyword(kw)) return false;
    advance();
    return true;
  }
  bool eat(Tok k) {
    if (peek().kind != k) return false;
    advance();
    return true;
  }

  void fail(std::string message, const Token& at) {
    if (err_.failed) return;  // keep the FIRST error; later ones are cascades
    err_.failed = true;
    err_.message = std::move(message);
    err_.begin = at.begin;
    err_.end = at.end;
  }

  u32 intern(std::string_view s) {
    for (u32 i = 0; i < static_cast<u32>(q_.strings.size()); ++i) {
      if (q_.strings[i] == s) return i;
    }
    q_.strings.emplace_back(s);
    return static_cast<u32>(q_.strings.size() - 1);
  }

  u32 add(Node n) {
    q_.nodes.push_back(n);
    return static_cast<u32>(q_.nodes.size() - 1);
  }

  // ── query ────────────────────────────────────────────────────────────────

  void parse_query() {
    if (at_end()) {
      fail("empty query — start with a source, e.g. `earthquakes`", peek());
      return;
    }
    if (peek().kind != Tok::Ident) {
      fail("expected a source name, e.g. `earthquakes` or `vessels`", peek());
      return;
    }
    q_.source = std::string(text_of(advance()));

    while (!at_end() && !err_.failed) {
      if (eat_keyword("where")) {
        q_.filter_root = parse_expr();
      } else if (at_keyword("within")) {
        parse_within();
      } else if (at_keyword("in")) {
        parse_bbox();
      } else if (eat_keyword("since")) {
        q_.since = parse_temporal();
      } else if (at_keyword("order")) {
        parse_order();
      } else if (eat_keyword("limit")) {
        parse_limit();
      } else if (at_keyword("as")) {
        parse_as_of();
      } else {
        fail("unexpected `" + std::string(text_of(peek())) +
                 "` — expected where, within, in bbox, since, order by, limit, or as of",
             peek());
        return;
      }
    }
  }

  void parse_within() {
    advance();  // 'within'

    if (peek().kind != Tok::Number) {
      fail("expected a distance after `within`, e.g. `within 50km`", peek());
      return;
    }
    const f64 magnitude = advance().number;

    if (peek().kind != Tok::Ident) {
      fail("expected a unit: km, m, or nm", peek());
      return;
    }
    const Token& unit_tok = advance();
    const std::string_view unit = text_of(unit_tok);

    f64 metres;
    if (iequals(unit, "km")) metres = magnitude * 1000.0;
    else if (iequals(unit, "m")) metres = magnitude;
    else if (iequals(unit, "nm")) metres = magnitude * 1852.0;  // international nautical mile
    else {
      fail("unknown distance unit `" + std::string(unit) + "` — use km, m, or nm", unit_tok);
      return;
    }

    if (!eat_keyword("of")) {
      fail("expected `of` after the distance", peek());
      return;
    }

    q_.within.present = true;
    q_.within.distance_m = metres;

    // Either an explicit (lat, lon) or a named place resolved at plan time.
    if (eat(Tok::LParen)) {
      const bool lat_neg = eat(Tok::Minus);
      if (peek().kind != Tok::Number) {
        fail("expected a latitude", peek());
        return;
      }
      q_.within.lat = advance().number * (lat_neg ? -1.0 : 1.0);

      if (!eat(Tok::Comma)) {
        fail("expected `,` between latitude and longitude", peek());
        return;
      }
      const bool lon_neg = eat(Tok::Minus);
      if (peek().kind != Tok::Number) {
        fail("expected a longitude", peek());
        return;
      }
      q_.within.lon = advance().number * (lon_neg ? -1.0 : 1.0);

      if (!eat(Tok::RParen)) {
        fail("expected `)` to close the coordinate", peek());
        return;
      }
      q_.within.has_point = true;
      return;
    }

    if (peek().kind == Tok::Ident) {
      const Token& key = advance();
      if (!eat(Tok::Colon)) {
        fail("expected `:` — a place looks like `port:SGSIN`", peek());
        return;
      }
      if (peek().kind != Tok::Ident && peek().kind != Tok::Number &&
          peek().kind != Tok::String) {
        fail("expected a place identifier after `:`", peek());
        return;
      }
      const Token& value = advance();
      q_.within.place_key = intern(text_of(key));
      q_.within.place_value = intern(text_of(value));
      return;
    }

    fail("expected a coordinate `(lat, lon)` or a place like `port:SGSIN`", peek());
  }

  void parse_bbox() {
    advance();  // 'in'
    if (!eat_keyword("bbox")) {
      fail("expected `bbox` after `in`", peek());
      return;
    }
    if (!eat(Tok::LParen)) {
      fail("expected `(` after `bbox`", peek());
      return;
    }

    f64 v[4] = {0, 0, 0, 0};
    for (int k = 0; k < 4; ++k) {
      const bool neg = eat(Tok::Minus);
      if (peek().kind != Tok::Number) {
        fail(arity_message(k), peek());
        return;
      }
      v[k] = advance().number * (neg ? -1.0 : 1.0);

      if (k < 3 && !eat(Tok::Comma)) {
        // Distinguish "you stopped early" from "you wrote the wrong
        // separator". A closing paren or end-of-input after too few
        // coordinates is an ARITY mistake, and telling the user about a
        // missing comma sends them to fix the wrong thing — `bbox(1, 2)` looks
        // complete to whoever typed it.
        if (peek().kind == Tok::RParen || peek().kind == Tok::End) {
          fail(arity_message(k + 1), peek());
        } else {
          fail("expected `,` between bbox coordinates", peek());
        }
        return;
      }
    }
    if (!eat(Tok::RParen)) {
      fail("expected `)` to close bbox", peek());
      return;
    }

    q_.bbox = BBoxClause{true, v[0], v[1], v[2], v[3]};
  }

  static std::string arity_message(int got) {
    return "bbox takes four numbers: min_lat, min_lon, max_lat, max_lon (got " +
           std::to_string(got) + ")";
  }

  void parse_order() {
    advance();  // 'order'
    if (!eat_keyword("by")) {
      fail("expected `by` after `order`", peek());
      return;
    }
    if (peek().kind != Tok::Ident) {
      fail("expected a field name to order by", peek());
      return;
    }
    q_.order_by = std::string(text_of(advance()));

    if (eat_keyword("desc")) q_.order_desc = true;
    else if (eat_keyword("asc")) q_.order_desc = false;
  }

  void parse_limit() {
    if (peek().kind != Tok::Number) {
      fail("expected a number after `limit`", peek());
      return;
    }
    const Token& t = advance();
    if (t.number < 0 || t.number > 4'000'000'000.0) {
      fail("limit is out of range", t);
      return;
    }
    q_.limit = static_cast<u32>(t.number);
  }

  void parse_as_of() {
    advance();  // 'as'
    if (!eat_keyword("of")) {
      fail("expected `of` after `as`", peek());
      return;
    }
    q_.as_of.present = true;
    q_.as_of.valid = parse_temporal();
    if (err_.failed) return;

    // The '@' half is what makes this bitemporal rather than merely temporal:
    // `as of X @ Y` means "valid at X, as we believed at Y".
    if (eat(Tok::At)) {
      q_.as_of.system = parse_temporal();
    }
  }

  TemporalClause parse_temporal() {
    TemporalClause t;

    // Forward offsets exist because forecasts do. NOAA's aurora model asserts a
    // probability for an instant roughly eighty minutes ahead of the observation
    // that produced it, so `as of +90m` is the only relative way to reach the
    // region of the scrubber above the diagonal.
    const bool forward = peek().kind == Tok::Plus;
    if (forward || peek().kind == Tok::Minus) {
      advance();
      if (peek().kind != Tok::Number) {
        fail(forward ? "expected a number after `+`, e.g. `+90m`"
                     : "expected a number after `-`, e.g. `-6h`",
             peek());
        return t;
      }
      const f64 amount = advance().number;

      if (peek().kind != Tok::Ident) {
        fail("expected a time unit: s, m, h, d, or w", peek());
        return t;
      }
      const Token& unit_tok = advance();
      const std::string_view unit = text_of(unit_tok);

      i64 seconds;
      if (iequals(unit, "s")) seconds = 1;
      else if (iequals(unit, "m")) seconds = 60;
      else if (iequals(unit, "h")) seconds = 3600;
      else if (iequals(unit, "d")) seconds = 86400;
      else if (iequals(unit, "w")) seconds = 604800;
      else {
        fail("unknown time unit `" + std::string(unit) + "` — use s, m, h, d, or w",
             unit_tok);
        return t;
      }

      // The amount is arbitrary user input, and `static_cast<i64>` of a double
      // outside i64's range is undefined behaviour rather than merely a wrong
      // answer — so it is bounded BEFORE the cast, not after.
      //
      // The limit is deliberately absurd: 1e12 weeks is longer than the age of
      // the universe. Anything approaching it is a typo or an attack, not a
      // query, and a refusal says so more usefully than a silently wrapped
      // timestamp would.
      //
      // This was reachable before forward offsets existed — `as of -1e20h` hit
      // the same cast. The parser fuzzer had not generated a twenty-digit
      // number followed by a unit letter; a targeted run did so immediately.
      constexpr f64 kMaxAmount = 1e12;
      if (!std::isfinite(amount) || amount < 0.0 || amount > kMaxAmount) {
        fail("time offset is out of range", unit_tok);
        return t;
      }

      t.present = true;
      t.relative = true;
      // resolve_time computes `now - relative_seconds`, so a forward offset is
      // simply a negative one. Encoding it here keeps the planner ignorant of
      // direction.
      t.relative_seconds = static_cast<i64>(amount) * seconds * (forward ? -1 : 1);
      return t;
    }

    if (peek().kind == Tok::String) {
      const Token& tok = advance();
      const i64 unix = parse_iso8601(text_of(tok));
      if (unix == kBadTime) {
        fail("could not parse `" + std::string(text_of(tok)) +
                 "` — expected ISO-8601, e.g. \"2026-03-01T00:00:00Z\"",
             tok);
        return t;
      }
      t.present = true;
      t.absolute_unix = unix;
      return t;
    }

    fail("expected a time: a relative offset like `-6h` or `+90m`, or a quoted ISO-8601 instant",
         peek());
    return t;
  }

  static constexpr i64 kBadTime = INT64_MIN;

  /// Minimal ISO-8601: YYYY-MM-DD, optionally THH:MM:SS, optionally Z.
  ///
  /// Hand-rolled rather than using std::get_time, which is locale-sensitive
  /// and inconsistent across libstdc++/libc++/emscripten — and this needs to
  /// give identical answers on both build targets.
  static i64 parse_iso8601(std::string_view s) {
    int y = 0, mo = 0, d = 0, h = 0, mi = 0, sec = 0;
    auto digits = [&](usize at, int count, int& out) -> bool {
      if (at + static_cast<usize>(count) > s.size()) return false;
      int v = 0;
      for (int k = 0; k < count; ++k) {
        const char c = s[at + static_cast<usize>(k)];
        if (c < '0' || c > '9') return false;
        v = v * 10 + (c - '0');
      }
      out = v;
      return true;
    };

    if (s.size() < 10) return kBadTime;
    if (!digits(0, 4, y) || s[4] != '-' || !digits(5, 2, mo) || s[7] != '-' ||
        !digits(8, 2, d)) {
      return kBadTime;
    }
    if (s.size() >= 19 && (s[10] == 'T' || s[10] == ' ')) {
      if (!digits(11, 2, h) || s[13] != ':' || !digits(14, 2, mi) || s[16] != ':' ||
          !digits(17, 2, sec)) {
        return kBadTime;
      }
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 60) {
      return kBadTime;
    }

    // Howard Hinnant's days-from-civil. Exact for the proleptic Gregorian
    // calendar and branch-free, with no dependence on the host timezone —
    // timegm is not portable and mktime would apply local time.
    const i64 yy = y - (mo <= 2 ? 1 : 0);
    const i64 era = (yy >= 0 ? yy : yy - 399) / 400;
    const i64 yoe = yy - era * 400;
    const i64 doy = (153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const i64 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    const i64 days = era * 146097 + doe - 719468;

    return days * 86400 + h * 3600 + mi * 60 + sec;
  }

  // ── expressions ──────────────────────────────────────────────────────────

  // ── recursion depth ──────────────────────────────────────────────────────
  //
  // Bounding the INPUT LENGTH does not bound recursion depth — that was the
  // first attempt and it segfaulted on 200 nested parentheses, which is only
  // ~400 bytes but ~800 stack frames. Depth has to be counted directly.
  //
  // 64 is far beyond any query a human writes and far below what either target
  // can survive. It matters most under wasm, where the stack is fixed at 4 MB
  // and an overflow surfaces as an opaque RuntimeError with no usable trace.
  static constexpr u32 kMaxDepth = 64;

  struct DepthGuard {
    Parser& p;
    bool ok;
    explicit DepthGuard(Parser& parser) : p(parser), ok(++parser.depth_ <= kMaxDepth) {}
    ~DepthGuard() { --p.depth_; }
  };

  u32 parse_expr() {
    DepthGuard g(*this);
    if (!g.ok) {
      fail("expression is nested too deeply", peek());
      return kNoNode;
    }
    return parse_or();
  }

  u32 parse_or() {
    u32 lhs = parse_and();
    while (!err_.failed && at_keyword("or")) {
      const Token& op = advance();
      const u32 rhs = parse_and();
      if (err_.failed) return kNoNode;
      Node n{};
      n.kind = NodeKind::Or;
      n.lhs = lhs;
      n.rhs = rhs;
      n.begin = op.begin;
      n.end = op.end;
      lhs = add(n);
    }
    return lhs;
  }

  u32 parse_and() {
    u32 lhs = parse_not();
    while (!err_.failed && at_keyword("and")) {
      const Token& op = advance();
      const u32 rhs = parse_not();
      if (err_.failed) return kNoNode;
      Node n{};
      n.kind = NodeKind::And;
      n.lhs = lhs;
      n.rhs = rhs;
      n.begin = op.begin;
      n.end = op.end;
      lhs = add(n);
    }
    return lhs;
  }

  u32 parse_not() {
    DepthGuard g(*this);
    if (!g.ok) {
      fail("expression is nested too deeply", peek());
      return kNoNode;
    }
    if (at_keyword("not")) {
      const Token& op = advance();
      const u32 operand = parse_not();
      if (err_.failed) return kNoNode;
      Node n{};
      n.kind = NodeKind::Not;
      n.lhs = operand;
      n.begin = op.begin;
      n.end = op.end;
      return add(n);
    }
    return parse_primary();
  }

  u32 parse_primary() {
    if (eat(Tok::LParen)) {
      const u32 inner = parse_expr();
      if (err_.failed) return kNoNode;
      if (!eat(Tok::RParen)) {
        fail("expected `)` to close the group", peek());
        return kNoNode;
      }
      return inner;
    }
    return parse_comparison();
  }

  u32 parse_comparison() {
    if (peek().kind != Tok::Ident) {
      fail("expected a field name", peek());
      return kNoNode;
    }
    const Token& field_tok = advance();

    // Dotted paths: properties.mag
    std::string field(text_of(field_tok));
    u32 field_end = field_tok.end;
    while (peek().kind == Tok::Dot && peek(1).kind == Tok::Ident) {
      advance();
      const Token& part = advance();
      field += '.';
      field += text_of(part);
      field_end = part.end;
    }

    CmpOp op;
    switch (peek().kind) {
      case Tok::Eq: op = CmpOp::Eq; break;
      case Tok::NotEq: op = CmpOp::NotEq; break;
      case Tok::Lt: op = CmpOp::Lt; break;
      case Tok::LtEq: op = CmpOp::LtEq; break;
      case Tok::Gt: op = CmpOp::Gt; break;
      case Tok::GtEq: op = CmpOp::GtEq; break;
      case Tok::Tilde: op = CmpOp::Contains; break;
      default:
        fail("expected a comparison operator (=, !=, <, <=, >, >=, ~) after `" + field + "`",
             peek());
        return kNoNode;
    }
    advance();

    Node lit{};
    const bool neg = eat(Tok::Minus);
    const Token& val = peek();

    if (val.kind == Tok::Number) {
      advance();
      lit.kind = NodeKind::LitNumber;
      lit.number = val.number * (neg ? -1.0 : 1.0);
      lit.begin = val.begin;
      lit.end = val.end;
    } else if (val.kind == Tok::String) {
      advance();
      lit.kind = NodeKind::LitString;
      lit.str = intern(text_of(val));
      lit.begin = val.begin;
      lit.end = val.end;
    } else if (val.kind == Tok::Ident) {
      advance();
      // `country:RU` versus a bare word.
      if (eat(Tok::Colon)) {
        if (peek().kind != Tok::Ident && peek().kind != Tok::String &&
            peek().kind != Tok::Number) {
          fail("expected a value after `:`", peek());
          return kNoNode;
        }
        const Token& pv = advance();
        lit.kind = NodeKind::LitPredicate;
        lit.str = intern(text_of(val));
        lit.lhs = intern(text_of(pv));
        lit.begin = val.begin;
        lit.end = pv.end;
      } else {
        lit.kind = NodeKind::LitString;
        lit.str = intern(text_of(val));
        lit.begin = val.begin;
        lit.end = val.end;
      }
    } else {
      fail("expected a value after the comparison operator", val);
      return kNoNode;
    }

    const u32 lit_idx = add(lit);

    Node fref{};
    fref.kind = NodeKind::FieldRef;
    fref.str = intern(field);
    fref.begin = field_tok.begin;
    fref.end = field_end;
    const u32 field_idx = add(fref);

    Node cmp{};
    cmp.kind = NodeKind::Compare;
    cmp.op = op;
    cmp.lhs = field_idx;
    cmp.rhs = lit_idx;
    cmp.begin = field_tok.begin;
    cmp.end = lit.end;
    return add(cmp);
  }

  std::string_view src_;
  std::vector<Token> toks_;
  usize pos_ = 0;
  u32 depth_ = 0;
  Query q_;
  ParseError err_;
};

}  // namespace

ParseResult parse(std::string_view src) {
  // A sanity bound on input volume. This is NOT what protects the stack —
  // recursion depth is bounded separately inside the parser, because length
  // and depth are independent (200 nested parens is 400 bytes and 800 frames).
  // This only stops someone pasting a megabyte into the query bar.
  constexpr usize kMaxQueryBytes = 8192;
  if (src.size() > kMaxQueryBytes) {
    ParseResult r;
    r.error.failed = true;
    r.error.message = "query is too long";
    r.error.begin = 0;
    r.error.end = static_cast<u32>(kMaxQueryBytes);
    return r;
  }

  Parser p(src, tokenize(src));
  return p.run();
}

}  // namespace px::ql
