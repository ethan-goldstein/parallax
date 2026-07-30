// ── px/ql/parser.hpp ────────────────────────────────────────────────────────
// Recursive descent with precedence climbing for the boolean expression.
//
// Grammar (EBNF):
//
//   query      = source , { pipe_op } , [ "as" , "of" , temporal , [ "@" , temporal ] ] ;
//   source     = ident ;
//   pipe_op    = filter | spatial | temporal_f | order | limit ;
//
//   filter     = "where" , expr ;
//   spatial    = "within" , distance , "of" , place
//              | "in" , "bbox" , "(" , num , "," , num , "," , num , "," , num , ")" ;
//   place      = predicate | "(" , num , "," , num , ")" ;
//   temporal_f = "since" , temporal ;
//   order      = "order" , "by" , field , [ "asc" | "desc" ] ;
//   limit      = "limit" , int ;
//
//   expr       = or_expr ;
//   or_expr    = and_expr , { "or" , and_expr } ;
//   and_expr   = not_expr , { "and" , not_expr } ;
//   not_expr   = [ "not" ] , primary ;
//   primary    = "(" , expr , ")" | comparison ;
//   comparison = field , cmp_op , literal ;
//   cmp_op     = "=" | "!=" | ">" | ">=" | "<" | "<=" | "~" ;
//
//   predicate  = ident , ":" , ( ident | string ) ;
//   field      = ident , { "." , ident } ;
//   distance   = num , ( "km" | "m" | "nm" ) ;
//   temporal   = rel_time | string ;
//   rel_time   = "-" , int , ( "s" | "m" | "h" | "d" | "w" ) ;
//
// Two worked examples:
//
//   vessels within 50km of (60.1, 24.9) since -6h limit 100
//   earthquakes where magnitude > 6.0 as of "2026-03-01T00:00:00Z" @ -30d
//
// The second is the one that shows off the store: magnitude-6 quakes valid on
// March 1, as we believed them thirty days ago.
// ────────────────────────────────────────────────────────────────────────────
#pragma once

#include <string_view>

#include "px/ql/ast.hpp"

namespace px::ql {

struct ParseResult {
  Query query;
  ParseError error;
};

[[nodiscard]] ParseResult parse(std::string_view src);

}  // namespace px::ql
