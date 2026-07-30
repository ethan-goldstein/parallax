// ── px/ql/token.hpp ─────────────────────────────────────────────────────────
// Tokens for the PARALLAX query language.
//
// Every token carries a byte span into the original source. That is what lets
// the UI underline the exact offending characters instead of saying "syntax
// error" and leaving the user to find it — and it costs two u32 per token.
// ────────────────────────────────────────────────────────────────────────────
#pragma once

#include <string_view>

#include "px/prelude.hpp"

namespace px::ql {

enum class Tok : u8 {
  End = 0,
  Error,

  Ident,   // bare word — could be a source, field, or keyword
  Number,  // 42, 6.5, -3
  String,  // "quoted"

  // punctuation
  Colon,      // :  predicate separator, country:RU
  Dot,        // .  field path
  LParen,
  RParen,
  Comma,
  At,         // @  separates valid time from system time in `as of`

  // comparison
  Eq,
  NotEq,
  Lt,
  LtEq,
  Gt,
  GtEq,
  Tilde,  // ~  substring match

  Minus,  // - relative time, and negative numbers
};

struct Token {
  Tok kind = Tok::End;
  u32 begin = 0;  // byte offset into the source
  u32 end = 0;    // exclusive
  f64 number = 0.0;

  [[nodiscard]] std::string_view text(std::string_view src) const noexcept {
    if (begin > src.size() || end > src.size() || end < begin) return {};
    return src.substr(begin, end - begin);
  }
};

/// Keywords are recognised by the PARSER, not the lexer.
///
/// Deliberate: `limit` is a keyword in `limit 10` and a perfectly good field
/// name in `where limit > 5`. A lexer that hardcodes keywords makes that
/// ambiguity unrepresentable and forces the language to reserve words it does
/// not need to. Keeping them as Ident and resolving by position is both
/// simpler here and friendlier to the user.
[[nodiscard]] bool iequals(std::string_view a, std::string_view b) noexcept;

}  // namespace px::ql
