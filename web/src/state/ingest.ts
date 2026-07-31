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
import type { AttrDecl, AttrIds, FeedStatus, SourceSpec, Viewport } from '../sources/spec'
import { layerByName } from '../sources'
import type { Batch, EntityRegistry } from '../sources/batch'

export interface IngestResult {
  feeds: FeedStatus[]
  /** Earliest and latest valid-time seen, for the scrubber's X axis. */
  validMin: number
  validMax: number
  ingestMs: number
  /** Transactions actually committed. Zero when a poll found nothing new. */
  batches: number
  /** Batches whose wall clock had to be clamped forward. Surfaced, not hidden. */
  clamped: number
  /** Facts dropped because they were already in the store. */
  duplicates: number
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
  /**
   * Attributes written by something that is not a polled source.
   *
   * The recon probes are the case: they have no unattended fetch, so they are
   * kept out of SOURCE_SPECS — but their attributes still have to be interned
   * and typed here, because this is the one place that can guarantee no
   * attribute reaches the store without a declared sensitivity.
   */
  extra: readonly AttrDecl[] = [],
): AttrIds {
  const sensitivity = new Map<string, Sensitivity>()
  const declarations = [...specs.flatMap((s) => s.attributes), ...extra]
  for (const decl of declarations) {
    const prev = sensitivity.get(decl.name) ?? Sensitivity.Public
    sensitivity.set(decl.name, decl.sensitivity > prev ? decl.sensitivity : prev)
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

export interface CycleOptions {
  signal?: AbortSignal
  /** Only fetch these. Defaults to every registered source. */
  only?: readonly SourceSpec[]
  /** Required by viewport-scoped sources; they are skipped without it. */
  view?: Viewport
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

  /**
   * Every fact already committed, so a refetch cannot commit it twice.
   *
   * ── this is a correctness requirement, not an optimisation ────────────────
   *
   * Polling USGS every few minutes returns the same earthquakes with the same
   * `updated` timestamps. Ingesting them again would mint a transaction carrying
   * no new information — and a transaction on the system axis MEANS "at this
   * moment our knowledge changed". Manufacturing them would make the scrubber's
   * Y axis a record of how often the page polled rather than of what was learned,
   * which is the one claim this entire project rests on. usgs.ts forbids exactly
   * this by name.
   *
   * The key is (source, entity, attribute, validFrom, validTo, systemTime). A
   * source re-asserting all six identically is re-sending a fact, not revising
   * one: a genuine revision changes its own `updated`, which changes the system
   * time, which changes the key. A source that changed a VALUE while keeping its
   * own revision timestamp fixed would be misreporting its own history, and no
   * amount of client-side hashing can rescue that.
   */
  #committed = new Set<string>()

  /**
   * The last payload each source returned, kept only for `derivation` sources.
   *
   * A TLE set is refetched every six hours but re-propagated every couple of
   * minutes, and re-propagating requires the elements, not the network. Held for
   * derived sources ONLY: caching an observation would invite recomputing it,
   * and recomputing an observation is inventing data.
   */
  #lastRaw = new Map<string, unknown>()

  /** Valid-time extent across every cycle, not just the most recent one. */
  #validMin = Number.POSITIVE_INFINITY
  #validMax = Number.NEGATIVE_INFINITY

  constructor(
    private readonly engine: Engine,
    private readonly registry: EntityRegistry,
    private readonly attrs: AttrIds,
    private readonly specs: readonly SourceSpec[] = SOURCE_SPECS,
  ) {
    for (const spec of specs) {
      if (spec.systemTimeIsFetchTime) this.#fetchTimeSources.add(spec.id)
    }
  }

  /** Facts committed so far. Exposed for the readout, and for tests. */
  get committedFacts(): number {
    return this.#committed.size
  }

  async cycle(opts: CycleOptions = {}): Promise<IngestResult> {
    const { signal, view } = opts
    const specs = (opts.only ?? this.specs).filter((s) => {
      // A viewport-scoped source with no viewport is skipped rather than asked
      // globally: the global form of that question is the one the endpoint is
      // not there to answer.
      if (s.viewport === 'required' && !view) return false
      return true
    })

    const feeds: FeedStatus[] = []
    let batches: Batch[] = []

    // allSettled, not all: one dead feed must degrade the map, not blank it.
    const settled = await Promise.allSettled(specs.map((spec) => spec.fetch(signal, view)))

    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]!
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
          intern: (text) => this.engine.intern(text),
        })
        if (count === 0) {
          feeds.push({ ...base, count: 0, error: 'no records' })
          continue
        }
        batches = batches.concat(b)
        if (spec.derivation) this.#lastRaw.set(spec.key, res.value)
        feeds.push({ ...base, count })
      } catch (err) {
        // A source that throws while building facts must not abort the cycle —
        // it is exactly as recoverable as one whose fetch failed.
        feeds.push({ ...base, count: 0, error: `normalize: ${String(err).slice(0, 48)}` })
      }
    }

    // ── the global ordering ──────────────────────────────────────────────
    batches.sort((a, b) => a.wallClockUnix - b.wallClockUnix)

    const t0 = performance.now()
    const { committed, clamped, duplicates } = this.#commit(batches)

    return {
      feeds,
      validMin: this.#validMin,
      validMax: this.#validMax,
      ingestMs: performance.now() - t0,
      batches: committed,
      clamped,
      duplicates,
    }
  }

  /**
   * Commits one batch outside the fetch cycle — a lookup a person just ran.
   *
   * Routed through the same path as a feed rather than calling engine.ingest
   * directly, so the monotonic clamp and the duplicate guard hold for every fact
   * in the store without exception. A second ingest path is a second set of
   * invariants to keep, and one of them would drift.
   */
  ingestOne(batch: Batch): { committed: number; duplicates: number } {
    const { committed, duplicates } = this.#commit([batch])
    return { committed, duplicates }
  }

  /**
   * Source ids whose system time this client invented.
   *
   * Resolved per FACT rather than per batch, because a cycle merges batches from
   * every due source into one sorted timeline — by the time they are committed
   * there is no longer a spec attached to them, only `fact.source`.
   */
  #fetchTimeSources = new Set<number>()

  /**
   * Re-derives from the last fetched payload, without touching the network.
   *
   * Only for sources declaring `derivation`. Each run asserts a position for a
   * NEW instant, so these are genuinely new facts rather than duplicates — a
   * satellite predicted to be somewhere at 14:32 and somewhere else at 14:34 is
   * two predictions, and the store is right to hold both.
   */
  recompute(specs: readonly SourceSpec[]): IngestResult {
    const t0 = performance.now()
    let batches: Batch[] = []
    const feeds: FeedStatus[] = []

    for (const spec of specs) {
      const raw = this.#lastRaw.get(spec.key)
      if (raw === undefined || !spec.derivation) continue
      const category = layerByName(spec.layer)?.category ?? 'hazards'
      try {
        const { batches: b, count } = spec.normalize(raw, {
          attrs: this.attrs,
          registry: this.registry,
          intern: (text) => this.engine.intern(text),
        })
        batches = batches.concat(b)
        feeds.push({
          key: spec.key,
          label: spec.label,
          layer: spec.layer,
          category,
          count,
          ...(spec.coverageNote !== undefined ? { coverageNote: spec.coverageNote } : {}),
        })
      } catch (err) {
        feeds.push({
          key: spec.key,
          label: spec.label,
          layer: spec.layer,
          category,
          count: 0,
          error: `recompute: ${String(err).slice(0, 40)}`,
        })
      }
    }

    batches.sort((a, b) => a.wallClockUnix - b.wallClockUnix)
    const { committed, clamped, duplicates } = this.#commit(batches)
    return {
      feeds,
      validMin: this.#validMin,
      validMax: this.#validMax,
      ingestMs: performance.now() - t0,
      batches: committed,
      clamped,
      duplicates,
    }
  }

  #commit(batches: readonly Batch[]): {
    committed: number
    clamped: number
    duplicates: number
  } {
    let clamped = 0
    let duplicates = 0
    let committed = 0

    for (const batch of batches) {
      let wall = batch.wallClockUnix
      if (wall < this.#lastWallClock) {
        wall = this.#lastWallClock
        clamped++
      }

      const fresh: typeof batch.facts = []
      for (const f of batch.facts) {
        // Keyed on the batch's OWN wall clock, never the clamped one. The clamp
        // depends on what else happened to be ingested first, so keying on it
        // made a fact's identity a function of its neighbours: re-fetching USGS
        // after some aircraft had arrived pushed every quake's clamped clock
        // forward, produced 1883 "new" transactions of data already in the store,
        // and reported zero duplicates while doing it.
        // The system time is part of a fact's identity because that is what
        // distinguishes a revision from a repeat — unless this client invented
        // it, in which case including it would make every refetch a revision.
        const stamp = this.#fetchTimeSources.has(f.source) ? '' : batch.wallClockUnix
        const key = `${f.source}:${f.entity}:${f.attr}:${f.validFrom}:${f.validTo}:${stamp}`
        if (this.#committed.has(key)) {
          duplicates++
          continue
        }
        this.#committed.add(key)
        fresh.push(f)
      }

      // A batch with nothing new in it commits NOTHING. Committing an empty
      // transaction would still advance the system axis, which is the exact lie
      // the duplicate guard exists to prevent.
      if (fresh.length === 0) continue

      this.#lastWallClock = wall

      // Valid range comes off the facts rather than each source reporting it,
      // and accumulates across cycles — recomputing it per cycle would shrink
      // the scrubber's X axis to whatever the latest poll happened to return.
      for (const f of fresh) {
        if (f.validFrom < this.#validMin) this.#validMin = f.validFrom
        if (f.validFrom > this.#validMax) this.#validMax = f.validFrom
      }

      this.engine.ingest(fresh, wall)
      committed++
    }

    // Once, after the last batch — see Engine.finishIngest. Per batch it is
    // quadratic, measured at 9.7 s.
    if (committed > 0) this.engine.finishIngest()

    return { committed, clamped, duplicates }
  }
}
