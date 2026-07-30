# ── Warnings ────────────────────────────────────────────────────────────────
# Applied to our code only, never to fetched dependencies.
#
# -Wconversion is the load-bearing one. The most common first-time C++ bug in a
# codebase this index-heavy is a silent narrowing between size_t / u32 / i32 in
# a loop bound or a bit shift, and it produces wrong results rather than a
# crash — which is exactly the kind of bug that survives to a demo. Making it a
# hard error costs a few explicit casts and buys back hours of debugging.
# ────────────────────────────────────────────────────────────────────────────

add_library(px_warnings INTERFACE)

if(MSVC)
  target_compile_options(px_warnings INTERFACE /W4 /permissive-)
else()
  target_compile_options(px_warnings INTERFACE
    -Wall
    -Wextra
    -Wshadow              # a shadowed loop index is a silent logic bug
    -Wconversion          # see above
    -Wsign-conversion
    -Wdouble-promotion    # accidental f32 -> f64 in hot loops
    -Wnon-virtual-dtor
    -Wold-style-cast
    -Wcast-align
    -Wunused
    -Woverloaded-virtual
    -Wnull-dereference
    -Wformat=2)
endif()

# Warnings-as-errors in CI only. Locally a warning should interrupt you, not
# block you mid-thought; in CI it must be fatal or it will be ignored forever.
option(PX_WERROR "Treat warnings as errors (CI sets this ON)" OFF)
if(PX_WERROR AND NOT MSVC)
  target_compile_options(px_warnings INTERFACE -Werror)
endif()
