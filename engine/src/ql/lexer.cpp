#include "px/ql/lexer.hpp"

#include <cctype>
#include <charconv>

namespace px::ql {

bool iequals(std::string_view a, std::string_view b) noexcept {
  if (a.size() != b.size()) return false;
  for (usize i = 0; i < a.size(); ++i) {
    const auto ca = static_cast<unsigned char>(a[i]);
    const auto cb = static_cast<unsigned char>(b[i]);
    if (std::tolower(ca) != std::tolower(cb)) return false;
  }
  return true;
}

namespace {

bool is_ident_start(char c) noexcept {
  const auto u = static_cast<unsigned char>(c);
  return std::isalpha(u) != 0 || c == '_';
}

bool is_ident_char(char c) noexcept {
  const auto u = static_cast<unsigned char>(c);
  return std::isalnum(u) != 0 || c == '_';
}

}  // namespace

std::vector<Token> tokenize(std::string_view src) {
  std::vector<Token> out;
  out.reserve(src.size() / 4 + 8);

  usize i = 0;
  const usize n = src.size();

  auto push = [&](Tok k, usize b, usize e, f64 num = 0.0) {
    out.push_back(Token{k, static_cast<u32>(b), static_cast<u32>(e), num});
  };

  while (i < n) {
    const char c = src[i];

    if (std::isspace(static_cast<unsigned char>(c)) != 0) {
      ++i;
      continue;
    }

    // Two-character operators must be tried before the one-character ones, or
    // `>=` lexes as `>` followed by a stray `=`.
    if (i + 1 < n) {
      const std::string_view two = src.substr(i, 2);
      if (two == ">=") { push(Tok::GtEq, i, i + 2); i += 2; continue; }
      if (two == "<=") { push(Tok::LtEq, i, i + 2); i += 2; continue; }
      if (two == "!=") { push(Tok::NotEq, i, i + 2); i += 2; continue; }
      if (two == "==") { push(Tok::Eq, i, i + 2); i += 2; continue; }
    }

    switch (c) {
      case ':': push(Tok::Colon, i, i + 1); ++i; continue;
      case '.': push(Tok::Dot, i, i + 1); ++i; continue;
      case '(': push(Tok::LParen, i, i + 1); ++i; continue;
      case ')': push(Tok::RParen, i, i + 1); ++i; continue;
      case ',': push(Tok::Comma, i, i + 1); ++i; continue;
      case '@': push(Tok::At, i, i + 1); ++i; continue;
      case '=': push(Tok::Eq, i, i + 1); ++i; continue;
      case '<': push(Tok::Lt, i, i + 1); ++i; continue;
      case '>': push(Tok::Gt, i, i + 1); ++i; continue;
      case '~': push(Tok::Tilde, i, i + 1); ++i; continue;
      default: break;
    }

    // '-' is deliberately its own token rather than being folded into a number
    // literal. It has to serve both `magnitude > -1` and the relative-time form
    // `-6h`, and letting the parser decide which is meant keeps the lexer from
    // needing to know the grammar.
    if (c == '-') {
      push(Tok::Minus, i, i + 1);
      ++i;
      continue;
    }

    // '+' exists only for forward relative time. There is no addition operator
    // in this language, so it never has to be disambiguated the way '-' does.
    if (c == '+') {
      push(Tok::Plus, i, i + 1);
      ++i;
      continue;
    }

    if (std::isdigit(static_cast<unsigned char>(c)) != 0) {
      const usize begin = i;
      while (i < n && (std::isdigit(static_cast<unsigned char>(src[i])) != 0)) ++i;
      if (i < n && src[i] == '.' && i + 1 < n &&
          std::isdigit(static_cast<unsigned char>(src[i + 1])) != 0) {
        ++i;
        while (i < n && (std::isdigit(static_cast<unsigned char>(src[i])) != 0)) ++i;
      }

      f64 value = 0.0;
      const char* first = src.data() + begin;
      const char* last = src.data() + i;
      // from_chars rather than strtod: no locale dependence (a machine with a
      // comma decimal separator would otherwise parse 6.5 as 6) and no
      // allocation.
      const auto res = std::from_chars(first, last, value);
      if (res.ec != std::errc{}) {
        push(Tok::Error, begin, i);
      } else {
        push(Tok::Number, begin, i, value);
      }
      continue;
    }

    if (c == '"' || c == '\'') {
      const char quote = c;
      const usize begin = i;
      ++i;
      while (i < n && src[i] != quote) ++i;
      if (i >= n) {
        // Unterminated. Span covers from the opening quote to end of input, so
        // the UI can highlight exactly what it could not close.
        push(Tok::Error, begin, n);
        break;
      }
      ++i;  // closing quote
      // Span excludes the quotes: consumers want the contents.
      push(Tok::String, begin + 1, i - 1);
      continue;
    }

    if (is_ident_start(c)) {
      const usize begin = i;
      while (i < n && is_ident_char(src[i])) ++i;
      push(Tok::Ident, begin, i);
      continue;
    }

    // Unknown byte. Emit one Error token and keep going rather than stopping,
    // so a single stray character does not hide every later problem.
    push(Tok::Error, i, i + 1);
    ++i;
  }

  push(Tok::End, n, n);
  return out;
}

}  // namespace px::ql
