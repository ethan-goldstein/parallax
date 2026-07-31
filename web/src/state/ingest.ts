// ── web/src/state/ingest.ts ─────────────────────────────────────────────────
// Fetches every registered source, merges their batches into ONE ascending
// timeline, and ingests that.
//
// ── why a scheduler exists at all ──────────────────────────────────────────
//
// TxnId is assigned by insertion order, and the store's system-time index
// depends on sys_from being non-decreasing — that is what makes the binary
// search in Store::upper_row_for_txn correct. Ingesting all of one feed and
// then all of another interleaves wall clocks against transaction order, so
// scrubbing to "as known at 14:00" would show a 14:30 vessel beside a 13:00
// quake.
//
// With two hardcoded feeds that was one sort call in main.ts. With sources on
// independent refresh timers, "ingest whatever just arrived" breaks the system
// axis outright, so collecting a whole cycle before ingesting any of it is not
// an optimisation — it is the invariant.
// ────────────────────────────────────────────────────────────────────────────
import type { Engine } from '../engine/engine'
import { LAYERS, SOURCE_SPECS } from '../sources'
import { Sensitivity } from '../sources/spec'
import type { AttrIds, FeedStatus, SourceSpec } from '../sources/spec'
import { layerByName } from '../sources'
import type { Batch, EntityRegistry } from '../sources/batch'

export interface IngestResult {
  feeds: FeedStatus[]
  /** Earliest and latest valid-time seen, for the scrubber's X axis. */
  validMin: number
  validMax: number
  ingestMs: number
  batches: number
  /** Batches whose wall clock had to be clamped forward. Surfaced, not hidden. */
  clamped: number
}

/**
 * Interns every declared attribute and registers its sensitivity.
 *
 * Two sources may declare the same attribute — USGS and EMSC both write
 * `position`, deliberately. When their declared sensitivities disagree the
 * HIGHER one wins. Anything else would let adding a permissive source quietly
 * downgrade an attribute another source declared as precise, which is a
 * privacy regression that would never show up in a test.
 */
export function registerAttributes(
  engine: Engine,
  specs: readonly SourceSpec[] = SOURCE_SPECS,
): AttrIds {
  const sensitivity = new Map<string, Sensitivity>()
  for (const spec of specs) {
    for (const decl of spec.attributes) {
      const prev = sensitivity.get(decl.name) ?? Sensitivity.Public
      sensitivity.set(decl.name, (decl.sensitivity > prev ? decl.sensitivity : prev))
    }
  }

  const attrs: Record<string, number> = {}
  for (const [name, level] of sensitivity) {
    const id = engine.intern(name)
    attrs[name] = id
    engine.setSensitivity(id, level)
  }
  return attrs
}

/**
 * Binds query-language names to the attributes carrying each layer's geometry
 * and scalar, so `earthquakes` and `vessels` mean different things to the
 * planner.
 */
export function registerQueryNames(engine: Engine, attrs: AttrIds): void {
  for (const layer of LAYERS) {
    const geo = attrs[layer.geoAttr]
    const scalar = attrs[layer.scalarAttr]
    if (geo === undefined || scalar === undefined) {
      // A layer naming an attribute no source declares is a wiring bug, not a
      // runtime condition. Say so loudly rather than registering a source name
      // that silently matches nothing.
      console.error(
        `[parallax] layer "${layer.name}" wants ${layer.geoAttr}/${layer.scalarAttr}, which no source declares`,
      )
      continue
    }
    for (const name of layer.qlNames) engine.registerSource(name, geo, scalar)
  }
}

export class Ingestor {
  /**
   * Wall clock of the last batch committed, across all cycles.
   *
   * The guard below clamps against this. Within one cycle the global sort
   * already guarantees monotonicity; across cycles it does not, because a slow
   * feed, a clock skew or a backfill can return a batch older than something
   * already committed.
   */
  #lastWallClock = Number.NEGATIVE_INFINITY

  constructor(
    private readonly engine: Engine,
    private readonly registry: EntityRegistry,
    private readonly attrs: AttrIds,
    private readonly specs: readonly SourceSpec[] = SOURCE_SPECS,
  ) {}

  async cycle(signal?: AbortSignal): Promise<IngestResult> {
    const feeds: FeedStatus[] = []
    let batches: Batch[] = []

    // allSettled, not all: one dead feed must degrade the map, not blank it.
    const settled = await Promise.allSettled(
      this.specs.map((spec) => spec.fetch(signal)),
    )

    for (let i = 0; i < this.specs.length; i++) {
      const spec = this.specs[i]!
      const res = settled[i]!
      const category = layerByName(spec.layer)?.category ?? 'hazards'

      const base = {
        key: spec.key,
        label: spec.label,
        layer: spec.layer,
        category,
        ...(spec.coverageNote !== undefined ? { coverageNote: spec.coverageNote } : {}),
      }

      if (res.status === 'rejected') {
        feeds.push({ ...base, count: 0, error: String(res.reason).slice(0, 60) })
        continue
      }

      try {
        const { batches: b, count } = spec.normalize(res.value, {
          attrs: this.attrs,
          registry: this.registry,
        })
        if (count === 0) {
          feeds.push({ ...base, count: 0, error: 'no records' })
          continue
        }
        batches = batches.concat(b)
        feeds.push({ ...base, count })
      } catch (err) {
        // A source that throws while building facts must not abort the cycle —
        // it is exactly as recoverable as one whose fetch failed.
        feeds.push({ ...base, count: 0, error: `normalize: ${String(err).slice(0, 48)}` })
      }
    }

    // ── the global ordering ──────────────────────────────────────────────
    batches.sort((a, b) => a.wallClockUnix - b.wallClockUnix)

    let clamped = 0
    let validMin = Number.POSITIVE_INFINITY
    let validMax = Number.NEGATIVE_INFINITY

    const t0 = performance.now()
    for (const batch of batches) {
      let wall = batch.wallClockUnix
      if (wall < this.#lastWallClock) {
        wall = this.#lastWallClock
        clamped++
      }
      this.#lastWallClock = wall

      // Valid range comes off the facts rather than each source reporting it —
      // one derivation instead of one near-identical loop per source.
      for (const f of batch.facts) {
        if (f.validFrom < validMin) validMin = f.validFrom
        if (f.validFrom > validMax) validMax = f.validFrom
      }

      this.engine.ingest(batch.facts, wall)
    }
    // Once, after the last batch — see Engine.finishIngest. Per batch it is
    // quadratic, measured at 9.7 s.
    if (batches.length > 0) this.engine.finishIngest()

    return {
      feeds,
      validMin,
      validMax,
      ingestMs: performance.now() - t0,
      batches: batches.length,
      clamped,
    }
  }
}
