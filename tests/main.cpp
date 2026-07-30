// doctest's main lives alone in its own translation unit so the ~7k-line
// implementation is compiled once instead of once per test file.
#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest.h>
