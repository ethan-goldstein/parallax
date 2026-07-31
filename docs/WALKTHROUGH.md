# PARALLAX — architecture walkthrough

Written for one purpose: so you can defend this in an interview.

A portfolio piece you cannot explain is worse than a smaller one you can. Read this before any
conversation where PARALLAX comes up. Everything here is a question someone will actually ask,
followed by the answer and — more importantly — the reasoning that produced it.

If you disagree with a decision below, say so in the interview. "I'd do this differently now, and
here's why" is a stronger answer than defending a choice you no longer believe.

---

## The 60-second version

> PARALLAX is a bitemporal analytical engine — it stores two independent time axes, so it can answer
> "what did we believe at system-time S, about valid-time T?" It's written in C++20 and compiled to
> both WebAssembly and a native binary from one codebase, so the whole thing runs in a browser with
> no backend while the native build gets sanitizers and benchmarks the browser can't provide. It
> ingests live open-source feeds — USGS and EMSC earthquakes, Finnish AIS — resolves cross-agency
> duplicates, and refuses queries that narrow to an individual asset unless you've declared a purpose
> that permits it.

Then stop. Let them pick which thread to pull.

---

## 1. What is bitemporality, and why does it matter?

Two independent time axes on every fact:

- **Valid time** — when the thing was true in the world. An earthquake's origin time.
- **System time** — when *we* came to believe it. When USGS published or revised the record.

A single-timestamp store cannot distinguish "the magnitude was 5.8" from "we thought the magnitude
was 5.8." When USGS revises 5.8 → 6.4 six hours later, a normal database overwrites and the earlier
belief is gone. Bitemporality keeps both, so you can ask what the operational picture looked like at
the moment a decision was made.

**Where the data comes from:** every USGS and EMSC feature carries both `time` and
`updated`/`lastupdate`. The system axis is *their* publication history, not something invented. If
you get asked "did you simulate that?" — no, and the code comments say why that would have been the
easy dishonest option.

**Likely follow-up: "Who else does this?"** Datomic, XTDB, SQL:2011's system-versioned tables,
Palantir Foundry. Say Datomic — the transaction-id design here is deliberately the same.

---

## 2. Why is system time a transaction id instead of a timestamp?

Three reasons, in order of how much they matter:

1. **Wall clock cannot order two writes in the same millisecond.** A monotonic counter always can, so
   "as known at S" has exactly one answer.
2. **4 bytes instead of 8**, and it participates in the same SIMD predicate as the valid-time columns.
3. **The scrubber's system axis snaps to real transactions** rather than sliding through instants at
   which nothing happened. Better interaction, not a compromise.

*Cost:* mapping a human instant ("as we believed at 14:00") onto a transaction requires a side table
and a binary search — `Store::txn_at_or_before`.

---

## 3. Walk me through the visibility predicate.

```cpp
visible = (sys_from <= S) & (S < sys_to) & (valid_from <= T) & (T < valid_to);
```

Four comparisons, all 32-bit, all half-open intervals.

**Why half-open:** consecutive versions tile the timeline with no overlap and no gap. A fact valid
`[0, 10)` followed by one valid `[10, 20)` has exactly one answer at every instant, including at 10.
Closed intervals would return two rows at the boundary.

**Why bitwise `&` and not `&&`:** short-circuit introduces a data-dependent branch per row. At ~50%
match rates the predictor cannot help, and the mispredicts cost more than evaluating both sides
always. The comparisons are cast to `int` explicitly so the intent is stated rather than implied.

**Why 32-bit:** the loop is memory-bound. Halving the bytes read roughly doubles throughput, and it
doubles the SIMD lane count. *Cost:* one-second resolution. No source here reports finer.

---

## 4. The indexes — and what each one cannot do

Three, covering complementary cases. Being able to say what each one *fails* at is the part that
lands.

| index | prunes | fails when |
| --- | --- | --- |
| zone maps (per 8192-row chunk) | valid-time axis | every `valid_to` is open — nothing is excludable at "now" |
| binary search on `sys_from` | system-time axis | never; it's exact and free (the column is monotone by construction) |
| Morton Z-order | space | quadrant boundaries split a box into several ranges; distorts near poles |

**The zone-map finding is worth volunteering unprompted.** In this data every fact is open-ended
("an earthquake, once it happened, stays true"), so at the latest valid time the zone maps skip
*nothing* — 0 of 245 chunks. Scrub backward and they skip everything. That's not a bug; it means the
two indexes are complementary rather than redundant, and it's a more interesting thing to say than
"the index makes it fast."

---

## 5. The JS↔WASM boundary — the part that took the most care

**The failure mode:** when the WASM heap grows, every `ArrayBuffer` JavaScript holds over it is
*detached*. No exception. No warning. The typed array reports `byteLength === 0`, reads return
`undefined`, writes vanish — and the symptom shows up somewhere else entirely, like an empty globe.

**Four defences, all needed:**
1. `INITIAL_MEMORY` pre-grown to 256 MB so growth essentially never happens
2. no typed array is ever cached across an engine call (`heap.ts` re-reads the view every time)
3. an engine-side generation counter, compared on every access
4. an `onmemorygrowth` hook that invalidates the local cache

**Three tiers, because one strategy is wrong for something:**
- *control plane* → embind (strings, structured returns, tens of calls/sec)
- *bulk out* → zero-copy views over fixed-capacity engine buffers
- *bulk in* → JS encodes into a staging buffer the engine owns, one `ingest(offset, len)` call

**"Why not parse JSON in C++?"** Because parsing belongs where the format is native and analytics
belong where memory layout matters. Writing a JSON parser in C++ would be a week spent to make the
system slower at the thing JS is already good at.

---

## 6. The bug that best demonstrates why the dual target earns its keep

I wrote the engine to return `u32` heap addresses. That is correct under wasm32, where the whole
linear memory is addressable in 32 bits — and it **silently truncates every 64-bit native pointer**.
The bounds checks could not catch it because they were comparing truncated values too.

ASan caught it on the native build. The fix was to keep pointers out of the engine's ABI entirely:
`ingest` takes an *offset* into a buffer whose size we own, which is unambiguous on both targets.
Narrowing to a 32-bit address now happens only in `bindings/wasm/px_wasm.cpp` — the one file that
knows it's in a browser.

**Two more from the same family, worth having ready:**
- `usize{1} << 40` — fine natively, a compile error on wasm32 where `size_t` is 32-bit
- `u64` is `unsigned long` on Linux and `unsigned long long` on macOS: distinct types at identical
  width, so mixing with a `ull` literal trips `-Wsign-conversion` under GCC only

---

## 7. How does the planner decide?

Greedy: enumerate the available access paths, cost each, pick the cheapest, apply the rest as a
residual filter. **Say "greedy access-path selection", not "cost-based optimiser"** — the latter
invites them to assume Cascades or Volcano, and this isn't one. There's no join reordering because
there are no joins.

**The genuinely unusual bit:** two of the four estimators are *exact*, not approximate.
- the Morton array is sorted, so counting entries in the decomposed key ranges is two binary searches
- the zone-map skip count runs the same predicate the executor will, once per chunk

So EXPLAIN shows `est == actual` on spatial and system-time operators and misses by ~25× on scalar
predicates, where selectivity is a flat 1/3 guess with no histograms. **That contrast is the point of
the panel.** A panel that only ever showed good estimates would be decoration.

---

## 8. Entity resolution — three stages

**Blocking.** Comparing every pair is O(n²) — 3,500 records is 6.1M comparisons. Two independent key
families (coarse Morton cell, 600-second time bucket) so a boundary miss in one is covered by the
other. Measured: 4.9M possible pairs → 2,527. **1,900× reduction.**

**Scoring.** Fellegi-Sunter log-odds: each field agreeing adds `log(m/u)`, disagreeing adds
`log((1-m)/(1-u))`. Contributions decay with distance rather than stepping at a threshold, so a pair
5 km apart outscores one 90 km apart — a hard threshold throws away exactly the information that
separates a confident merge from a marginal one.

**Clustering.** Union-find with path halving and union by rank.

**Three defensible model decisions:**
- same-source pairs are never compared — two USGS ids are two quakes by construction
- no single field can force a merge: geo agreement alone (3.2) sits below threshold (5.0)
- oversized blocks are capped **and counted** — silently capping means silently missing merges, and
  under-merging looks identical to having nothing to merge

**Volunteer the limitation:** m and u are hand-tuned from a config table, not EM-estimated. A tuned
model you're candid about beats an unexplained one.

**"Union-find can't un-merge."** Correct — so the accepted edge list is retained and un-merging
replays it without the removed edge. Components are small, so it's microseconds.

---

## 9. The policy engine — the part worth leading with at a defence-adjacent employer

The framing: **every capability here is dual-use.** A spatial index answering "which vessels are near
this port" answers "where is this specific vessel" with the same code path and the same cost. The
difference is intent, and a system that cannot represent intent cannot distinguish them.

So intent is represented: sessions declare a purpose, attributes carry a sensitivity, and rules run
against the **plan** — after cardinality is known, before any row is read. *A check that needed the
result set would already have done the thing it's about to refuse.*

The demo that makes it concrete: the identical 50 m radius is **refused for vessels and permitted for
earthquakes**, because sensitivity is typed per attribute. And the same vessel query flips from
refused to allowed when the purpose changes.

A denial is a **first-class result**, not an error — reported separately from parse failures, because
telling someone to fix their syntax when the query was understood perfectly and *declined* is a
different and worse answer.

**The audit trail is stored as ordinary facts in the bitemporal store**, so it is append-only for the
same structural reason the data is and scrubbable with the same control.

**Have the limitations ready:** `k=5` is a judgement call, not a standard. Unregistered attributes
default to `Public` — fail-open, defensible *only* because this project collects nothing
person-linked; in a system that did, that default must invert.

---

## 10. The benchmark result that undercuts the premise

Be the one to raise this. It is the most credible thing in the project.

The demo runs the identical predicate in C++ and JS over the same bytes in the WASM heap. **I
expected 8–20×. It measures ~1.3×.**

Why: a tight monomorphic loop over typed arrays is one of the very few things a JIT does nearly as
well as optimised C++, and this predicate is memory-bound — both languages stream the same four
32-bit columns at the same speed, so the compare is free either way. SIMD gave 1.31×, not 4×, for
exactly the same reason.

**So what does the C++ actually buy?**
- the indexes that avoid running the scan at all
- the zero-copy path from store to GPU — no per-entity JS object, ever
- the algorithms (ER, graph traversal) that would be painful against typed arrays

If they push: *"I'd rather publish the measurement that undercuts the premise than the one that
flatters it."*

---

## 11. Testing — differential, not example-based

The highest-value tests compare against a deliberately naive oracle **written before the optimised
version**, so it cannot inherit its bugs.

> For any random sequence of assertions and retractions, and any random `(T, S)`, the fast store's
> `as_of(T, S)` must equal the oracle's, as a sorted set.

Same pattern for the spatial index (brute-force bbox/k-NN) and ER (transitive closure by relaxation
instead of union-find).

**Two bugs these caught that unit tests would have missed:**
- `GeoPoint::from_degrees` *wraps* longitude — right for a point, catastrophic for a box corner. A
  window crossing the antimeridian came back inverted (`min_lon 175.8 > max_lon −175.8`), matched
  nothing silently, and k-NN then returned neighbours 12,000 km away.
- The classic bidirectional-BFS stitching error: each search root is its own parent, so when the
  frontiers meet *at* the target the forward walk appends it twice — a "path" containing a step that
  is not an edge.

Plus: sanitizers on every push, and **12.3M fuzz executions per 60-second CI run** on the parser.

---

## 12. Questions you should expect, and honest answers

**"Why C++ and not Rust?"** Rust would have prevented the pointer-truncation bug outright, and its
lifetime rules would have made the heap-view discipline compiler-enforced rather than convention. C++
was the constraint I set; if I were starting fresh for the same requirements I would seriously
consider Rust and say so.

**"Why not use PostGIS / DuckDB / Datomic?"** For production, I would. This exists to demonstrate the
mechanisms — the point is being able to explain how a zone map, a Z-order decomposition, and a
cost model work, not to compete with an engine that has had a hundred engineer-years.

**"Is 2M facts a lot?"** No. It's what fits comfortably in a 256 MB browser heap at 35 bytes a row,
and the README says so rather than implying more.

**"What would you do next?"** In order: wire the graph module to the UI (built and tested, unused);
execute `order by` and `since` rather than only planning them; histograms so scalar selectivity stops
being a 1/3 guess; snapshot persistence so a reload doesn't re-fetch.

**"What's the weakest part?"** The cost model constants are unvalidated — `seek = 30 × row_scan` is
an educated guess, not a calibration. It happens to pick the right plans on this data; I have not
proven it would on other shapes.

---

## Things NOT to say

- Don't call it "a Palantir alternative." That framing is a crowded cliché and it invites a
  comparison this cannot win.
- Don't say "cost-based optimiser" unqualified. Say greedy access-path selection.
- Don't quote the 1.3× as though it were disappointing. Frame it as the finding it is.
- Don't claim the graph module is in the product. It's built, tested, and unwired — say that.
- Don't oversell the clearance. It's on the résumé; here it's the *reason* the provenance and audit
  design exists.
