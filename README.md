# PARALLAX

A bitemporal analytical engine written in C++20 and compiled to WebAssembly. It answers
*"what did we believe about the world at system-time S, concerning valid-time T?"* — entirely in
your browser. No backend, no API keys, no login.

> **Status: Phase 1 of 8 — walking skeleton.** The build pipeline is live end to end (C++20 →
> emscripten → embind → Vite → GitHub Pages) and the engine boots in the browser. The engine itself
> is one function. Everything below marked *planned* is not built yet. This section will shrink as
> phases land; it will not be quietly deleted.

---

## Why this exists

Open-source intelligence dashboards render the present tense. They show where ships are now, where
earthquakes struck, what the news says — and when the data is corrected, the old value is gone
without a trace.

That erases the most decision-relevant question an analyst has: *not* what is true, but **when we
learned it, and what we believed before that.** A magnitude revised from 5.8 to 6.4 six hours later
is two different operational pictures, and only one of them was actionable at the time.

PARALLAX stores both time axes and lets you scrub either one independently.

## What's actually hard here

Three problems, and the reason the engine is C++ rather than TypeScript:

1. **Bitemporal visibility semantics that stay fast.** Four-predicate visibility
   (`sys_from ≤ S < sys_to ∧ valid_from ≤ T < valid_to`) over millions of rows, with indexes that
   accelerate it without ever changing the answer. *(Phase 2)*
2. **Moving 100k entities across the JS↔WASM boundary** every frame without copying and without
   dangling. WASM heap growth silently detaches every `ArrayBuffer` view JavaScript holds — no
   exception, reads just start returning `undefined`. *(Phase 3)*
3. **Cost-based query planning with honest cardinality estimates**, and a UI that shows the plan,
   the index chosen, and estimated-vs-actual rows. *(Phase 5)*

## Architecture

```
engine/          C++20. No emscripten, no I/O, no renderer. Bytes in, bytes out.
  ├── store      bitemporal columnar store (SoA, 8192-row chunks, zone maps)
  ├── geo        Z-order spatial index
  ├── graph      CSR adjacency + traversals
  ├── er         entity resolution (blocking → Fellegi-Sunter → union-find)
  └── ql         lexer → parser → cost-based planner → executor
        │
        ├── bindings/wasm  → parallax.wasm   (browser: the whole engine)
        └── native/        → px_cli, px_bench (benchmarks, reference outputs)
```

One codebase, two targets. The native build is what makes the tests meaningful — and in Phase 8 it
generates the reference query results that the browser build is asserted against, so *"one codebase,
two targets"* is a test rather than a claim.

## Build

```bash
./scripts/bootstrap.sh          # cmake, ninja, emsdk 6.0.5 — read it first
cmake --preset native-debug && cmake --build --preset native-debug
ctest --preset native-debug
./scripts/build-wasm.sh
npm --prefix web install && npm --prefix web run build
npm --prefix web run preview    # http://localhost:4173/parallax/
```

Use `preview`, not `dev`, to check anything path-related — it is the only local mode that serves
under the production base path.

## Data sources and licenses

Every source is free, keyless, and permits public redisplay. Each fact stored carries its source,
fetch time, and license; the UI can surface that per value. Full registry lands with Phase 4.

| Source | License | Use |
| --- | --- | --- |
| USGS earthquakes | US public domain | seismic events |
| GDACS | CC BY | disaster alerts |
| NASA EONET | US public domain | natural events |
| NOAA SWPC | US public domain | space weather |
| Digitraffic (FI) | CC BY 4.0 | AIS vessel positions |
| airplanes.live | community terms | ADS-B aircraft |
| Natural Earth | public domain | basemap, ports, airports |
| CelesTrak | US-gov derived | satellite elements (snapshotted, never per-visitor) |

## What this deliberately does not do

Restraint is a design requirement here, not an afterthought:

- **No CCTV or webcam feeds of people.** Public placement is not a lawful basis for processing
  images of identifiable individuals.
- **No scraping of MarineTraffic, Flightradar24, or VesselFinder.** Explicit ToS violations.
- **No tracking of named individuals.** ADS-B is open data; *"where is this person's aircraft"*
  turns open data into targeting a natural person. Aggregate and geographic framing only.
- **No ACLED redistribution.** Its license restricts derivative works and substitutes.
- **No TeleGeography cable data.** CC BY-NC-SA, and the endpoints are undocumented internals.

## What this is not

- **Single-threaded in the browser** — GitHub Pages cannot send COOP/COEP headers, so there is no
  `SharedArrayBuffer` and therefore no WASM threads. The native target does use threads, and Phase 8
  publishes the measured difference.
- Not a Palantir alternative, and not marketed as one.
- No persistence beyond committed snapshots.

## License

MIT — see [LICENSE](LICENSE).

---

Built by Ethan Goldstein — B.S. Computer Information Systems, University of South Carolina '27.
Active Public Trust clearance. I process government records at GovCIO, which is where the provenance
and audit requirements in this project came from: every field in PARALLAX carries its source, fetch
time, and license because that is what handling real records teaches you to expect.
