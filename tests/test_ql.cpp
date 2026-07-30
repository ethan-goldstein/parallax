#include <string>

#include <doctest.h>

#include "px/ql/lexer.hpp"
#include "px/ql/parser.hpp"

using namespace px;
using namespace px::ql;

namespace {

Query ok(std::string_view src) {
  ParseResult r = parse(src);
  INFO("query: ", std::string(src), "  error: ", r.error.message);
  REQUIRE_FALSE(r.error.failed);
  return std::move(r.query);
}

ParseError bad(std::string_view src) {
  ParseResult r = parse(src);
  INFO("query: ", std::string(src));
  REQUIRE(r.error.failed);
  return r.error;
}

}  // namespace

// ── lexer ──────────────────────────────────────────────────────────────────

TEST_CASE("lexer produces an End token even for empty input") {
  const auto t = tokenize("");
  REQUIRE(t.size() == 1);
  CHECK(t[0].kind == Tok::End);
}

TEST_CASE("lexer prefers two-character operators") {
  const auto t = tokenize(">= <= != ==");
  REQUIRE(t.size() == 5);
  CHECK(t[0].kind == Tok::GtEq);
  CHECK(t[1].kind == Tok::LtEq);
  CHECK(t[2].kind == Tok::NotEq);
  CHECK(t[3].kind == Tok::Eq);
}

TEST_CASE("lexer spans exclude string quotes") {
  const std::string src = "\"hello\"";
  const auto t = tokenize(src);
  REQUIRE(t[0].kind == Tok::String);
  CHECK(t[0].text(src) == "hello");
}

TEST_CASE("unterminated string spans to end of input") {
  const std::string src = "vessels where name = \"oops";
  const auto t = tokenize(src);
  bool found_error = false;
  for (const Token& tok : t) {
    if (tok.kind == Tok::Error) {
      found_error = true;
      CHECK(tok.end == src.size());
    }
  }
  CHECK(found_error);
}

TEST_CASE("numbers parse without locale dependence") {
  const auto t = tokenize("6.5 42 0.001");
  REQUIRE(t.size() == 4);
  CHECK(t[0].number == doctest::Approx(6.5));
  CHECK(t[1].number == doctest::Approx(42));
  CHECK(t[2].number == doctest::Approx(0.001));
}

// ── parser: the shapes that matter ─────────────────────────────────────────

TEST_CASE("bare source") {
  const Query q = ok("earthquakes");
  CHECK(q.source == "earthquakes");
  CHECK(q.filter_root == kNoNode);
}

TEST_CASE("the README example parses") {
  const Query q = ok("vessels within 50km of (60.1, 24.9) since -6h limit 100");
  CHECK(q.source == "vessels");
  REQUIRE(q.within.present);
  CHECK(q.within.distance_m == doctest::Approx(50'000.0));
  CHECK(q.within.has_point);
  CHECK(q.within.lat == doctest::Approx(60.1));
  CHECK(q.within.lon == doctest::Approx(24.9));
  REQUIRE(q.since.present);
  CHECK(q.since.relative);
  CHECK(q.since.relative_seconds == 6 * 3600);
  CHECK(q.limit == 100);
}

TEST_CASE("the bitemporal example parses") {
  // The query the whole project exists to answer: magnitude-6 quakes valid on
  // March 1, as we believed them thirty days ago.
  const Query q = ok("earthquakes where magnitude > 6.0 as of \"2026-03-01T00:00:00Z\" @ -30d");
  CHECK(q.source == "earthquakes");
  REQUIRE(q.as_of.present);
  REQUIRE(q.as_of.valid.present);
  CHECK_FALSE(q.as_of.valid.relative);
  CHECK(q.as_of.valid.absolute_unix == 1772323200);  // 2026-03-01T00:00:00Z
  REQUIRE(q.as_of.system.present);
  CHECK(q.as_of.system.relative);
  CHECK(q.as_of.system.relative_seconds == 30 * 86400);
}

TEST_CASE("ISO-8601 parsing is timezone independent") {
  // Hand-rolled days-from-civil rather than std::get_time, which is
  // locale-sensitive and differs across libstdc++/libc++/emscripten. These
  // must be identical on both build targets.
  CHECK(ok("q as of \"1970-01-01T00:00:00Z\"").as_of.valid.absolute_unix == 0);
  CHECK(ok("q as of \"2000-01-01T00:00:00Z\"").as_of.valid.absolute_unix == 946684800);
  CHECK(ok("q as of \"2026-07-30\"").as_of.valid.absolute_unix == 1785369600);
  // Leap day.
  CHECK(ok("q as of \"2024-02-29T12:00:00Z\"").as_of.valid.absolute_unix == 1709208000);
}

TEST_CASE("negative numbers and coordinates") {
  const Query q = ok("earthquakes where magnitude > -1 within 10km of (-33.87, 151.21)");
  CHECK(q.within.lat == doctest::Approx(-33.87));
  CHECK(q.within.lon == doctest::Approx(151.21));
}

TEST_CASE("bbox takes four numbers") {
  const Query q = ok("vessels in bbox(-10, -20, 30, 40)");
  REQUIRE(q.bbox.present);
  CHECK(q.bbox.min_lat == doctest::Approx(-10));
  CHECK(q.bbox.min_lon == doctest::Approx(-20));
  CHECK(q.bbox.max_lat == doctest::Approx(30));
  CHECK(q.bbox.max_lon == doctest::Approx(40));
}

TEST_CASE("distance units convert correctly") {
  CHECK(ok("v within 1km of (0,0)").within.distance_m == doctest::Approx(1000));
  CHECK(ok("v within 500m of (0,0)").within.distance_m == doctest::Approx(500));
  // International nautical mile, exactly 1852 m.
  CHECK(ok("v within 1nm of (0,0)").within.distance_m == doctest::Approx(1852));
}

TEST_CASE("boolean precedence: and binds tighter than or") {
  const Query q = ok("earthquakes where a > 1 or b > 2 and c > 3");
  // Expect Or(a>1, And(b>2, c>3)) — the root must be the Or.
  REQUIRE(q.filter_root != kNoNode);
  const Node& root = q.nodes[q.filter_root];
  REQUIRE(root.kind == NodeKind::Or);
  CHECK(q.nodes[root.rhs].kind == NodeKind::And);
}

TEST_CASE("parentheses override precedence") {
  const Query q = ok("earthquakes where (a > 1 or b > 2) and c > 3");
  const Node& root = q.nodes[q.filter_root];
  REQUIRE(root.kind == NodeKind::And);
  CHECK(q.nodes[root.lhs].kind == NodeKind::Or);
}

TEST_CASE("not binds to the nearest primary") {
  const Query q = ok("earthquakes where not a > 1 and b > 2");
  const Node& root = q.nodes[q.filter_root];
  REQUIRE(root.kind == NodeKind::And);
  CHECK(q.nodes[root.lhs].kind == NodeKind::Not);
}

TEST_CASE("keywords are usable as field names") {
  // The lexer deliberately does not reserve keywords — `limit` is a keyword by
  // position, not by spelling, so a data field called limit still works.
  const Query q = ok("vessels where limit > 5 limit 10");
  CHECK(q.limit == 10);
  REQUIRE(q.filter_root != kNoNode);
}

TEST_CASE("dotted field paths") {
  const Query q = ok("earthquakes where properties.mag >= 4.5");
  const Node& cmp = q.nodes[q.filter_root];
  CHECK(q.str(q.nodes[cmp.lhs].str) == "properties.mag");
}

TEST_CASE("predicate literals") {
  const Query q = ok("vessels where flag = country:RU");
  const Node& cmp = q.nodes[q.filter_root];
  const Node& lit = q.nodes[cmp.rhs];
  REQUIRE(lit.kind == NodeKind::LitPredicate);
  CHECK(q.str(lit.str) == "country");
  CHECK(q.str(lit.lhs) == "RU");
}

TEST_CASE("substring operator") {
  const Query q = ok("earthquakes where place ~ \"Alaska\"");
  CHECK(q.nodes[q.filter_root].op == CmpOp::Contains);
}

TEST_CASE("order by, with direction") {
  CHECK(ok("earthquakes order by magnitude desc").order_desc);
  CHECK_FALSE(ok("earthquakes order by magnitude asc").order_desc);
  CHECK(ok("earthquakes order by magnitude").order_by == "magnitude");
}

TEST_CASE("clauses may appear in any order") {
  const Query q = ok("vessels limit 5 since -1h within 2km of (0,0)");
  CHECK(q.limit == 5);
  CHECK(q.since.present);
  CHECK(q.within.present);
}

// ── errors carry usable spans ──────────────────────────────────────────────

TEST_CASE("errors point at the offending token") {
  const std::string src = "earthquakes where magnitude >> 6";
  const ParseError e = bad(src);
  // The span must cover the actual problem so the UI can underline it —
  // "syntax error" with no position is what makes a query bar frustrating.
  CHECK(e.begin >= 27);
  CHECK(e.end <= src.size());
  CHECK(!e.message.empty());
}

TEST_CASE("the first error is kept, not the last") {
  // Later errors are usually cascades from the first; reporting the last one
  // sends the user to the wrong place.
  //
  // Note what the parser does here, and why it is right: keywords are not
  // reserved, so `and` is accepted as a FIELD NAME and the failure lands on
  // the missing comparison operator. That is a more useful message than
  // "unexpected keyword", and it is the same rule that lets a data field
  // called `limit` work.
  const ParseError e = bad("earthquakes where and or");
  CHECK(e.message.find("comparison operator") != std::string::npos);
  CHECK(e.message.find("`and`") != std::string::npos);
}

TEST_CASE("helpful messages for common mistakes") {
  CHECK(bad("").message.find("empty query") != std::string::npos);
  // A clause keyword in source position is consumed as the source name (they
  // are not reserved), so this fails on the token AFTER it. The message names
  // the token and lists what was expected.
  CHECK(bad("within 5km of (0,0)").message.find("unexpected") != std::string::npos);
  CHECK(bad("vessels within 50 of (0,0)").message.find("unit") != std::string::npos);
  CHECK(bad("vessels within 50furlongs of (0,0)").message.find("furlongs") !=
        std::string::npos);
  CHECK(bad("earthquakes as of -6q").message.find("time unit") != std::string::npos);
  CHECK(bad("earthquakes as of \"not-a-date\"").message.find("ISO-8601") !=
        std::string::npos);
  CHECK(bad("earthquakes frobnicate 3").message.find("frobnicate") != std::string::npos);
}

TEST_CASE("unbalanced parentheses are reported, not crashed on") {
  CHECK(bad("earthquakes where (a > 1").message.find(")") != std::string::npos);
  // A truncated bbox fails where the input actually runs out — at the missing
  // separator after the third number, not at the paren.
  CHECK(bad("vessels in bbox(1, 2, 3").message.find(",") != std::string::npos);
  CHECK(bad("vessels in bbox(1, 2, 3, 4").message.find(")") != std::string::npos);
  CHECK(bad("vessels in bbox(1, 2)").message.find("four numbers") != std::string::npos);
}

TEST_CASE("absurdly long queries are rejected on volume") {
  std::string huge(20000, 'x');
  CHECK(bad(huge).message.find("too long") != std::string::npos);
}

TEST_CASE("deep nesting is rejected on DEPTH, not length") {
  // This case segfaulted the first implementation. 200 nested parens is ~400
  // bytes — well inside any length limit — but ~800 stack frames. Length and
  // depth are independent, so the guard has to count depth directly.
  std::string deep = "earthquakes where ";
  for (int i = 0; i < 200; ++i) deep += "(";
  deep += "a > 1";
  for (int i = 0; i < 200; ++i) deep += ")";

  const ParseError e = bad(deep);
  CHECK(e.message.find("nested too deeply") != std::string::npos);
}

TEST_CASE("deeply nested `not` is also bounded") {
  std::string deep = "earthquakes where ";
  for (int i = 0; i < 300; ++i) deep += "not ";
  deep += "a > 1";
  CHECK(bad(deep).message.find("nested too deeply") != std::string::npos);
}

TEST_CASE("nesting within the limit still parses") {
  std::string ok_depth = "earthquakes where ";
  for (int i = 0; i < 20; ++i) ok_depth += "(";
  ok_depth += "a > 1";
  for (int i = 0; i < 20; ++i) ok_depth += ")";
  ParseResult r = parse(ok_depth);
  CHECK_FALSE(r.error.failed);
}

TEST_CASE("garbage input never crashes the parser") {
  // Smoke coverage for the shapes the fuzzer explores continuously in CI.
  const char* junk[] = {
      "\xff\xfe\x00", "((((((", "))))))", "where", "as of", "@@@@", "-", "--",
      "1.2.3.4",      "\"\"",   "''",     ":::",   "..",    "where where where",
      "earthquakes where where > 1",
  };
  for (const char* s : junk) {
    ParseResult r = parse(s);
    // The only contract is: it returns. Success or failure are both fine.
    CHECK((r.error.failed || !r.query.source.empty() || r.query.source.empty()));
  }
}
