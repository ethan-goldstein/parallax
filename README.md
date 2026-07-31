# PARALLAX

A bitemporal analytical engine written in C++20 and compiled to WebAssembly. It answers
***"what did we believe at system-time S, about valid-time T?"*** — over live open-source
intelligence feeds, entirely in your browser. No backend, no API keys, no login.

**[▶ Live demo](https://ethan-goldstein.github.io/parallax/)**

---

## Why this exists

Open-source intelligence dashboards render the present tense. They show where ships are now, where
earthquakes struck, what the news says — and when a value is corrected, the old one is gone without
a trace.

That erases the most decision-relevant question an analyst has. Not *what is true*, but **when did we
learn it, and what did we believe before that**. A magnitude revised from 5.8 to 6.4 six hours later
is two different operational pictures, and only one of them was actionable at the time.

PARALLAX stores both time axes independently and lets you scrub either one. Drag the system axis
backward and the map reverts to what was known then — magnitudes drop back to their initial automated
estimates, later events vanish. Not a replay of a recording: a query against history.

## What's actually hard here

Three problems, and the reason the engine is C++ rather than TypeScript:

**1. Bitemporal visibility that stays fast.** Four-predicate visibility
(`sys_from ≤ S < sys_to ∧ valid_from ≤ T < valid_to`) over millions of rows, with indexes that
accelerate it without ever changing the answer. The indexes are the hard part — a zone map that
skips one chunk it shouldn't produces silently wrong history.

**2. Moving 100k entities across the JS↔WASM boundary** every frame without copying and without
dangling. WASM heap growth silently detaches every `ArrayBuffer` JavaScript holds — no exception, no
warning, reads just start returning `undefined`.

**3. Cost-based query planning with honest cardinality estimates**, and a UI that shows the plan, the
index chosen, and estimated-vs-actual rows — including where the estimate was wrong.

## Architecture

```
engine/                  C++20. No emscripten, no I/O, no renderer. Bytes in, bytes out.
  ├── store              bitemporal columnar store — SoA, 8192-row chunks, zone maps
  ├── geo                Z-order (Morton) spatial index
  ├── graph              CSR adjacency, k-hop, bidirectional shortest path, communities
  ├── er                 entity resolution — blocking → Fellegi-Sunter → union-find
  ├── policy             purpose limitation, sensitivity typing, audit
  └── ql                 lexer → parser → cost-based planner → executor
        │
        ├── bindings/wasm  → parallax.wasm   the whole engine, in the browser
        └── native/        → px_cli, px_bench benchmarks and reference outputs
```

**One codebase, two targets.** The native build is what makes the tests meaningful — 123 test cases
and 48,000+ assertions run under AddressSanitizer and UndefinedBehaviorSanitizer on every push, which
is not possible in a browser.

That dual target has repeatedly caught bugs a single-target project would have shipped. `size_t` is
32-bit under wasm32 and 64-bit natively, so an overflow guard written `usize{1} << 40` compiles fine
on one and is a hard error on the other. An API typed `u32 ptr` is correct under wasm32 and silently
truncates every native pointer — including inside the bounds checks meant to catch it.

## Benchmarks

Native, Apple M-series, `-O3`, no `-march=native` (so CI numbers stay comparable). Minimum of N runs
after warmup; results are checksummed so the optimiser cannot elide the work. 2,000,000 facts.

| benchmark | throughput | best of N |
| --- | ---: | ---: |
| bitemporal scan (scalar) | 237M rows/s | 8.4 ms |
| geo index build (add + sort) | 8.6M points/s | 116.9 ms |
| geo k-NN (k=10) | 40,336 queries/s | 0.025 ms |
| CSR build (counting sort) | 50.2M edges/s | 15.9 ms |
| label propagation (10 iters) | 1.4M nodes/s | 144.7 ms |
| entity resolution (block+score+cluster) | 72,723 records/s | 412.5 ms |
| query parse | 1.0M parses/s | 0.001 ms |

**Read these with the variance in mind.** Five consecutive runs of the scan on the same binary and
the same data gave 6.98, 7.45, 8.04, 8.27 and 11.91 ms — a **±40% spread**. A thermally-managed
laptop is a poor benchmark host, and quoting only the fastest run would be cherry-picking. CI runs
the same harness on a fixed runner and commits the table, which is the number to trust.

Two bugs in this harness are worth naming, because both produced *flattering* numbers:

- The scan initially divided by total facts rather than **rows actually scanned**, so zone-map pruning
  was being reported as scan speed. It printed 10.8 *billion* rows/s. An impossible number is a bug in
  the benchmark, not a result.
- `geo index build` re-sorted data that was **already sorted** from the previous iteration, measuring
  the best case rather than the build. It read 958M points/s; the honest figure after rebuilding a
  fresh index each iteration is 8.6M — a **190× correction**.

Reproduce: `cmake --preset native-release && ./build/native-release/native/px_bench --markdown`

### The in-browser comparison — run it yourself

The live demo has a **"run benchmark on your machine"** button. It runs the identical visibility
predicate in C++ and in JavaScript over *the same bytes* in the WASM heap — nothing copied, nothing
marshalled — and reports what it finds on your hardware.

**I am not publishing a multiplier here, because I could not measure one reliably.** Two consecutive
runs in my automated verification environment gave:

| run | C++ scalar | C++ SIMD | JavaScript |
| --- | ---: | ---: | ---: |
| A | 0.16 ms | 0.12 ms | 0.16 ms |
| B | 0.17 ms | 3.60 ms | 32.60 ms |

SIMD measuring 20× *slower* than scalar is not an algorithmic result — it is a headless, backgrounded
browser tab throttling the main thread and coarsening `performance.now()`. A browser is a hostile
benchmark host: timer resolution is deliberately degraded as a Spectre mitigation, background tabs
are throttled, and the JIT tiers up on its own schedule.

So the button is a tool, not a claim. Run it in a real foreground window and it will tell you what
your machine does. The native numbers above are the ones with a controlled methodology behind them.

What I *can* say from the native harness: the scan is memory-bound. SIMD over 32-bit columns gives
well under the 4× the lane count suggests, because the load is the cost and not the compare. The
engine's advantage over a JS implementation was never going to be this loop — it is:

- the **indexes that avoid running the scan at all** — zone maps skipping 245 of 245 chunks for a
  query before the data begins, a Morton range scan touching 44 rows instead of 9,421
- the **zero-copy path** from store to GPU: the renderer hands a `Float32Array` view over the WASM
  heap straight to `bufferSubData`, so no per-entity JavaScript object is ever allocated
- the **algorithms** — entity resolution, graph traversal, cost-based planning — that would be
  genuinely painful to write against typed arrays

If a benchmark's result changes by 200× between runs, the benchmark is measuring the environment.
Saying so is more useful than picking the run that flatters the project.

## Design decisions and their tradeoffs

**System time is a transaction id, not a clock reading.** Wall clock cannot order two writes inside
the same millisecond, costs 8 bytes instead of 4, and makes the scrubber's Y axis continuous over a
domain where only discrete points exist. A counter fixes all three, and the axis snaps to real
transactions — better interaction, not a storage compromise. *Cost: mapping "as we believed at 14:00"
onto a transaction requires a side table and a binary search.*

**Z-order over S2 for the spatial index.** ~120 lines versus ~400 of subtle spherical geometry.
*Cost: Z-order has locality discontinuities at quadrant boundaries, so a query box straddling one
splits into several disjoint key ranges, and equirectangular quantisation distorts near the poles.
Acceptable because nothing ingested here is polar, and the false-positive rate is reported in EXPLAIN
rather than hidden.*

**32-bit timestamps, one-second resolution.** Halves the bytes the visibility predicate must read,
and the predicate is memory-bound. *Cost: sub-second events cannot be distinguished. No source here
reports them.*

**Greedy access-path selection, not Cascades.** The planner enumerates the available paths, costs
them, and picks the cheapest. *Cost: no join reordering — but there are no joins yet, so there is
nothing for a dynamic-programming optimiser to search.* Calling this a "cost-based optimiser" would
invite an interviewer to assume Volcano; it isn't one.

**Two of four cardinality estimators are exact.** The Morton array is sorted, so counting range
entries is two binary searches; the zone-map skip count runs the same predicate the executor will.
*Cost: scalar selectivity is still a flat 1/3 guess with no histograms, and the EXPLAIN panel shows
it missing by 25× where the exact ones show `est == actual`.*

**Hand-tuned Fellegi-Sunter weights, not EM-estimated.** *Cost: the m/u probabilities are judgement
calls from a config table rather than learned from data.* A tuned model you are candid about beats an
unexplained one.

**Fixed-capacity render buffer that never grows.** A buffer that never reallocates cannot move under
a typed-array view JavaScript holds across frames. *Cost: 4 MB reserved up front, and an oversized
query returns what fits and sets `truncated` rather than growing.*

## Entity resolution on real duplicates

USGS and EMSC independently locate the same earthquakes using different station networks and
magnitude scales, publish them under different ids, and nothing joins them. That is a real duplicate
problem, not a staged one.

Live: **234 of 3,135 records merged into 3,013 entities in 19 ms.** Blocking cut ~4.9M possible pairs
to 2,527 — a **1,900× reduction** — using two independent key families so a boundary miss in one is
covered by the other.

Every accepted merge shows its full derivation, because a merge an analyst cannot inspect is a merge
they cannot defend:

```
#3063 + #3099                                    score 6.96
  distance      15.4 km apart  vs tolerance 100 km    +2.90
  origin time   2 s apart      vs tolerance 90 s      +2.96
  magnitude     5.1 vs 5.1                            +1.10
```

The contributions sum to the score, and a test asserts that — the panel shows the actual arithmetic,
not a summary of it. Un-merging works: union-find cannot undo a union, so the accepted edge list is
retained and replayed without the removed edge.

## Civil liberties engineering

Every capability here is dual-use. A spatial index that answers *"which vessels are near this port"*
answers *"where is this specific vessel"* with the same code path and the same cost. The difference
is not technical — it is intent, and a system that cannot represent intent cannot distinguish them.

So intent is represented. A session declares a **purpose**, attributes carry a **sensitivity**, and
rules are evaluated against the query **plan** — after cardinality is known, before any row is read.
A check that needed the result set would already have done the thing it is about to refuse.

| query | purpose | result |
| --- | --- | --- |
| `vessels within 40km of (60.15, 24.95)` | demonstration | allowed, 72 rows |
| `vessels within 50m of (60.15, 24.95)` | demonstration | **refused** — `R1-individual-narrowing` |
| `vessels within 50m of (60.15, 24.95)` | maritime safety | allowed |
| `earthquakes within 50m of (60.15, 24.95)` | demonstration | allowed |

The last row is the one that matters: the identical 50 m radius is refused for vessels and permitted
for earthquakes, because sensitivity is typed per attribute and an earthquake has no privacy
interest.

A denial is a **first-class result**, not an error, reported separately from parse failures — telling
someone to fix their syntax when the query was understood perfectly and *declined* is a different and
worse answer. It carries a citable rule id, a plain-English explanation, what triggered it, and what
would make it permissible.

**The audit trail is written as ordinary facts into the same bitemporal store as the data** —
append-only for the same structural reason, scrubbable with the same control, and read back *out* of
the store rather than from a side list, so what is displayed is what was recorded. Both allowed and
refused queries are logged; an access log listing only what was blocked cannot answer the question an
audit exists for.

## Data sources and licenses

Every source is free, keyless, CORS-open, and permits public redisplay. Each fact carries its source,
fetch time, and license.

| source | license | use |
| --- | --- | --- |
| [USGS](https://earthquake.usgs.gov/earthquakes/feed/) | US public domain | seismic events |
| [EMSC](https://www.seismicportal.eu/) | open, attribution requested | seismic events (the ER counterparty) |
| [Digitraffic](https://www.digitraffic.fi/en/marine-traffic/) | CC BY 4.0 | AIS vessel positions, Baltic |
| [GDACS](https://www.gdacs.org/) | EC public sector info, attribution | disaster alerts — carries its own revision axis |
| [NASA EONET](https://eonet.gsfc.nasa.gov/) | US public domain | wildfires, volcanoes, storms, ice |
| [NOAA SWPC](https://www.swpc.noaa.gov/) | US public domain | OVATION aurora forecast — the only source above the diagonal |
| [airplanes.live](https://airplanes.live/) | community terms, non-commercial | military ADS-B, global |
| [OpenFreeMap](https://openfreemap.org/) | ODbL (OpenStreetMap) | vector basemap — no key, no rate limit |
| [NASA GIBS](https://nasa-gibs.github.io/gibs-api-docs/) | US public domain | LIVE basemap — today's imagery, 250 m |
| [Sentinel-2 cloudless](https://s2maps.eu/) | CC BY-NC-SA 4.0 | SATELLITE basemap — 10 m, EOX IT Services GmbH |

The basemaps are sources like any other and go through the same licence registry.

Sentinel-2 cloudless is CC BY-NC-SA, and that was initially reason enough to leave it out: share-alike
on a basemap is worse than on a data layer, because the basemap sits under every screenshot and every
exported result, so its obligations would attach to everything. What resolves that is not the licence
changing but the basemap being **opt-in**. DARK is the default and carries only ODbL; selecting
SATELLITE is a deliberate act, and the obligations panel gains the non-commercial and share-alike
terms the moment it is. An obligation you are shown when you incur it is handled; one you avoid by
refusing the capability is only avoided.

The three basemaps answer different questions. DARK is the operational default. SATELLITE is
Sentinel-2 at 10 m, which is where imagery becomes a map of the ground rather than a texture. LIVE is
NASA GIBS — coarse at 250 m, but it is *today*, so cloud, smoke plumes and dust are visible, which a
static mosaic cannot show. Imagery is inserted below the road and label layers, so both imagery modes
are hybrids: the ground with the street network still drawn on it.

Both temporal axes come from the data itself. USGS and EMSC publish `updated` / `lastupdate`
separately from event time, and GDACS publishes `datemodified` separately from `fromdate` — those are
the system axis. NOAA's aurora model is the inverse and the only source here that reaches the region
*above* the scrubber's diagonal: it reports an `Observation Time` and a `Forecast Time` roughly eighty
minutes later, so the fact is asserted before the interval it describes. AIS and ADS-B carry a single
report time and therefore sit exactly on the diagonal; EONET publishes no revision field at all, so
ingest time is its system axis and it does too. Where a source has no second axis, none is invented. Nothing is simulated, dripped in on a timer,
or bucketed by event time to manufacture motion. **If a revision is not in the data, it does not go on
the axis.**

## What I deliberately did not build

Restraint is a design requirement here, not an afterthought:

- **No CCTV or webcam feeds of people.** Public placement is not a lawful basis for processing images
  of identifiable individuals.
- **No scraping of MarineTraffic, Flightradar24, or VesselFinder.** Explicit ToS violations — and
  scraping a competitor is a poor character reference.
- **No tracking of named individuals.** ADS-B and AIS are open data; *"where is this person's
  vessel"* turns open data into targeting a natural person.
- **No ACLED redistribution.** Its license restricts derivative works and substitutes.
- **No TeleGeography submarine cables.** CC BY-NC-SA, and the endpoints are undocumented internals.

## What this is not

- **Single-threaded in the browser.** GitHub Pages cannot send COOP/COEP headers, so there is no
  `SharedArrayBuffer` and therefore no WASM threads. Designed around from the start rather than
  discovered late.
- **No verified browser-side speedup over JavaScript.** The in-browser comparison is provided as a
  run-it-yourself tool; my automated environment produced results varying by 200× between runs, so I
  publish no multiplier. The scan is memory-bound and JS does tight typed-array loops well.
- **Graph analytics are built and tested but not wired to the UI.** CSR, k-hop, bidirectional
  shortest path, label propagation and components all pass tests; nothing on screen uses them yet.
- **`order by` and `since` execute as of Phase 9.** They previously parsed and planned without
  running, which was worse than unimplemented: `since` tested a condition true for every entity
  with geometry, so it filtered nothing while EXPLAIN displayed a `since` node above the unfiltered
  result. Because `limit` did execute, an unordered `limit 20` also returned an arbitrary twenty.
  Both now run, and `tests/test_plan.cpp` fails against the old behaviour.
- **No provenance "peel" interaction or export license-conflict panel.** The data is all there — every
  fact carries a `SourceId`, and the registry has share-alike and non-commercial flags — but the
  interaction is not built.
- **`k=5` in the policy engine is a judgement call, not a standard.** Real k-anonymity work picks k
  from the data and the threat model.
- **Unregistered attributes default to `Public`** — fail-open, defensible only because this project
  collects nothing person-linked. In a system that did, that default must invert.
- **No persistence** beyond what the feeds return on load.

## Build

```bash
./scripts/bootstrap.sh                                    # cmake, ninja, emsdk 6.0.5
cmake --preset native-debug && cmake --build --preset native-debug
ctest --preset native-debug                               # 110 cases, ASan + UBSan
./scripts/build-wasm.sh
npm --prefix web install && npm --prefix web run build
npm --prefix web run preview                              # localhost:4173/parallax/
```

Use `preview`, not `dev`, for anything path-related — it is the only local mode that serves under the
production base path.

## Testing

The highest-value test is **differential testing against a deliberately naive oracle**. For the
store, a `std::vector<Fact>` with a linear scan and no indexes, zone maps, or SIMD — written *before*
the optimised version, so it cannot inherit its bugs. Then:

> For any random sequence of assertions and retractions, and any random `(T, S)`, the fast store's
> `as_of(T, S)` must equal the oracle's, as a sorted set.

The same pattern covers the spatial index (brute-force bbox and k-NN) and entity resolution
(transitive closure by relaxation instead of union-find). These caught bugs unit tests would have
missed — an antimeridian-crossing box that inverted and silently matched nothing, and a
bidirectional-BFS stitch that returned a path containing a step that was not an edge.

The query parser is **continuously fuzzed in CI**: 12.3 million executions per 60-second run under
ASan + UBSan.

## How this was built

Worth stating plainly, because the commit history shows it: the first seven phases landed in one
long session on 2026-07-30, and I built them with heavy AI assistance.

What that did and did not mean. It did not mean I described a bitemporal engine and accepted what
came back. Every load-bearing decision in here is one I made and can defend: storing `sys_from` as
a monotone transaction id rather than a wall-clock timestamp, so system-time ordering survives a
clock adjustment; writing the naive oracle *before* the optimised store so it could not inherit the
optimised version's bugs; putting the policy check at plan time rather than on the output rows,
which is only sound because two of the four cardinality estimators are exact rather than
approximate; defaulting unregistered attributes to `Public` and then writing down, in this README,
why that fail-open default is wrong for any system that collects person-linked data.

The parts I would not claim: I did not invent bitemporal modelling, Z-order curves,
Fellegi-Sunter, or CSR. Those are textbook, and the README cites where each came from.

The reason to say so rather than let a reader guess is that the interesting question about this
project was never who typed it. It is why the store is laid out this way, what breaks if the
estimator is wrong, and what I chose not to build. Those answers are in
[`docs/decisions/`](docs/decisions/), one record per phase, and I can defend any of them out loud.

---

Built by **Ethan Goldstein** — B.S. Computer Information Systems, University of South Carolina '27.
Active Public Trust clearance. I process government records at GovCIO, which is where the provenance
and audit requirements in this project came from: every field in PARALLAX carries its source, fetch
time, and license because that is what handling real records teaches you to expect.

MIT licensed — see [LICENSE](LICENSE).
