# 0006. The scrubber owns both time axes, and the engine takes them as parameters

**Status:** accepted, Phase 10.

## Context

The interface was rebuilt around a tab rail and a single dock, and the query bar became a builder that
compiles to the query language in front of the user. That work surfaced a bug that had been sitting in
`web/src/main.ts` since queries were added:

```ts
const baseRefresh = refresh
refresh = function () {
  if (queryActive) return
  baseRefresh()
}
```

Two lines above it, a comment read *"Scrubbing while a query is active re-runs it, so the two time
axes and the query language stay the same mechanism rather than competing ones."* The code did the
opposite. **Dragging either time axis did nothing whenever a query was showing** — in the mode a
visitor is most likely to be in, on the control the entire project exists to demonstrate.

The original author's reason is recoverable from the API: `Session::run_query(sql, now_unix)` takes no
temporal position, so re-running the same string produced an identical result. The temporal position
lived only inside the query's own `as of` clause.

## The obvious fix, and why it is wrong

Append the clause. The parser accepts `as of "2026-03-01T00:00:00" @ "2026-02-01T00:00:00"`, and
`plan.cpp` resolves both halves — so the UI could rewrite the SQL from the scrubber position on every
frame and change nothing in C++.

That is lossy, and measurably so. **The system axis is a transaction INDEX, not a clock** (decision
0001). The `@` half of `as of` takes a wall clock and resolves it with
`store.txn_at_or_before(...)` — which returns the *last* transaction at or before that instant. When
several transactions share a second, the index that comes back is not the one the user selected.

Measured against the live feed set: of 2,983 transactions, 706 shared a wall-clock second with another,
and **49 of the last 50 did** — because every live feed buckets into the current minute. The one region
of the axis where the ambiguity is total is the region the scrubber opens on.

## Decision

`Session::run_query` takes a `QueryOptions`:

```cpp
struct QueryOptions {
  bool has_time_override = false;
  Timestamp valid_at = 0;
  u32 sys_at = 0;      // a transaction INDEX, passed through unconverted
  bool record = true;  // whether this run enters the audit trail
};
```

The override is applied inside `plan_query`, at the point the axes are resolved and *before* any
access path is costed — so the plan's cardinality estimates describe the instant actually executed.
Applying it afterwards would leave EXPLAIN comparing an estimate for one moment against an actual for
another, which is the one panel that must not lie.

It also wins over an `as of` clause in the SQL. The UI reads that clause first (`hasAsOf`) and, when
the query names its own instant, runs it *without* an override and stops the scrubber driving it — the
language keeps its full expressiveness and the scrubber does not silently overrule it.

## Why `record` is part of the same struct

Dragging the scrubber re-asks one query at sixty instants a second, and `Session::run_query` writes
every allowed query into the store as audit facts. Sixty identical entries per second is not an audit
trail; it is the thing that makes an audit trail unreadable, which answers no better than not keeping
one.

So a re-run driven by the axes moving is executed and **fully policy-checked**, and simply not written
down. Only the record is suppressed, only while the query text is unchanged, and **refusals are
recorded regardless** — losing the fact that something was refused is exactly the gap an audit trail
must not have.

## Consequences

- **A C++ change was required for a UI bug.** That is the honest shape of it: the UI was asking a
  question the API could not express, and rewriting SQL to fake it would have been wrong 98% of the
  time at the end of the axis.
- **`transactions()` must not be mutated in place.** The scrubber holds the array it was given and
  compares against its length to decide whether the user was watching the newest transaction. Updating
  it with `length = 0; push(...)` before calling `setTransactions` made that check always false, and
  the system axis silently stopped following. Found by a layer that ingested correctly and rendered
  nothing.
- **The present is not an event, so something has to advance it.** With a source whose facts are valid
  only around now, freezing `validAt` at page load drains the map: measured at 8 of 408 civil aircraft
  still inside their validity window after 92 seconds. A two-second tick walks the valid axis forward
  and stops the moment a human touches it — the same `tail -f` question as the system axis, against a
  different clock.
- **`validAt` no longer defaults to `validMax`.** That was fine while every fact was open-ended. It
  stopped being fine when a source arrived with a *bounded* window: `validMax` is the furthest instant
  any fact claims, the aurora forecast claims eighty minutes ahead, and satellites valid for ±150
  seconds around now did not exist there. It defaults to the present, which is also the better answer.
- **A layer can now be correctly empty**, and that needed saying rather than hiding. Aurora holds ~970
  facts and renders zero at the present instant because it forecasts ahead. The panel says so —
  *"972 facts held, none valid at the instant the scrubber is on"* — which turns a confusing zero into
  the clearest available statement of what the valid axis is for.

## What was rejected

**Re-running the query only on scrubber release.** Cheap, and it removes the live feedback that is the
entire reason the control exists.

**Suppressing the audit write by comparing against the last recorded query text.** Nearly right, and
it silently swallows a human deliberately asking the same question twice. The distinction that matters
is *who asked*, not *what was asked*, so the flag is threaded from the interaction rather than inferred.
