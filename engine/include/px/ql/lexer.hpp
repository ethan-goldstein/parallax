// ── px/ql/lexer.hpp ─────────────────────────────────────────────────────────
// Single-pass hand-written lexer.
//
// Hand-written rather than generated because the language is small, the error
// messages matter more than the grammar's elegance, and a generated lexer
// would be a build dependency for ~150 lines of code.
//
// It never fails. Malformed input produces a Tok::Error token carrying the
// offending span, and the parser decides what to say about it. A lexer that
// aborts loses the position information that makes an error message useful.
// ────────────────────────────────────────────────────────────────────────────
#pragma once

#include <string_view>
#include <vector>

#include "px/ql/token.hpp"

namespace px::ql {

/// Tokenises `src`. The returned vector always ends with a Tok::End token, so
/// the parser can look ahead one token without bounds-checking every access.
[[nodiscard]] std::vector<Token> tokenize(std::string_view src);

}  // namespace px::ql
