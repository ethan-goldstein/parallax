#include <string>
#include <unordered_set>
#include <vector>

#include <doctest.h>

#include "px/symbols.hpp"

using namespace px;

TEST_CASE("interning the same text returns the same id") {
  SymbolTable t;
  const SymbolId a = t.intern("vessel");
  const SymbolId b = t.intern("vessel");
  const SymbolId c = t.intern("vessels");

  CHECK(a == b);
  CHECK(a != c);
  CHECK(t.text(a) == "vessel");
  CHECK(t.text(c) == "vessels");
}

TEST_CASE("the empty string is id zero") {
  SymbolTable t;
  // "absent" and "empty" collapsing to one value removes a branch from every
  // call site that would otherwise have to distinguish them.
  CHECK(t.intern("").v == 0u);
  CHECK(t.text(SymbolId{0}).empty());
}

TEST_CASE("find does not intern") {
  SymbolTable t;
  t.intern("known");

  CHECK(t.find("known").valid());
  CHECK_FALSE(t.find("unknown").valid());

  // Matters for query planning: a filter on a string that appears nowhere in
  // the data must be answerable as "zero rows" without mutating the table.
  const usize before = t.size();
  (void)t.find("still-unknown");
  CHECK(t.size() == before);
}

TEST_CASE("invalid and out-of-range ids return empty rather than reading garbage") {
  SymbolTable t;
  t.intern("a");
  CHECK(t.text(SymbolId{}).empty());
  CHECK(t.text(SymbolId{9999}).empty());
}

TEST_CASE("strings survive rehash and blob growth") {
  SymbolTable t;
  std::vector<SymbolId> ids;
  std::vector<std::string> texts;

  // Well past the initial 1024 buckets and the reserved 4 KB blob, so this
  // forces both a rehash and several reallocations of chars_.
  constexpr int kN = 5000;
  for (int i = 0; i < kN; ++i) {
    texts.push_back("symbol-with-some-length-" + std::to_string(i));
    ids.push_back(t.intern(texts.back()));
  }

  REQUIRE(t.size() == static_cast<usize>(kN) + 1);  // +1 for the empty string

  // Every id must still resolve to its original text. If rehash dropped or
  // duplicated an entry this fails loudly rather than silently returning the
  // wrong attribute name three subsystems later.
  for (int i = 0; i < kN; ++i) {
    CHECK(t.text(ids[static_cast<usize>(i)]) == texts[static_cast<usize>(i)]);
    CHECK(t.intern(texts[static_cast<usize>(i)]) == ids[static_cast<usize>(i)]);
  }

  std::unordered_set<u32> unique;
  for (const SymbolId id : ids) unique.insert(id.v);
  CHECK(unique.size() == static_cast<usize>(kN));
}

TEST_CASE("string_view from text() is invalidated by a later intern") {
  // Documents the one sharp edge in this file. The header states the rule —
  // never hold a string_view across an intern() — and this test exists so that
  // the rule is demonstrably real rather than defensive folklore.
  //
  // It asserts on the SymbolId path (which is always safe), not on the
  // dangling view itself: reading a dangling view is undefined behaviour, and
  // a test that does it would be caught by ASan rather than proving anything.
  SymbolTable t;
  t.reserve_chars(8);  // guarantee reallocation on the next few inserts

  const SymbolId first = t.intern("aaaaaaaaaaaaaaaa");
  const std::string snapshot{t.text(first)};

  for (int i = 0; i < 200; ++i) t.intern("filler-" + std::to_string(i));

  // Re-derive the view after the growth. This is the correct pattern.
  CHECK(t.text(first) == snapshot);
}

TEST_CASE("embedded NUL bytes round-trip") {
  SymbolTable t;
  const std::string with_nul("ab\0cd", 5);
  const SymbolId id = t.intern(with_nul);

  // Lengths are stored explicitly rather than relying on termination, so a
  // string from a binary snapshot cannot be silently truncated.
  CHECK(t.text(id).size() == 5);
  CHECK(t.text(id) == with_nul);
}
