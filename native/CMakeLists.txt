# ── native targets ──────────────────────────────────────────────────────────
# px_cli exists so the engine can be driven without a browser in the loop.
# Debugging a query planner through a WASM boundary and a render pipeline is a
# bad trade when the same code path is reachable from a terminal in 3 ms, and
# in Phase 8 the same binary produces the reference outputs that the browser is
# asserted against.
#
# px_bench and px_snapshot join this list in later phases.
# ────────────────────────────────────────────────────────────────────────────

add_executable(px_cli px_cli.cpp)
target_link_libraries(px_cli PRIVATE px_core px_warnings)
