// ── web/src/state/scheduler.ts ──────────────────────────────────────────────
// Decides WHEN each source is refetched. Never ingests anything itself.
//
// Before this, `Ingestor.cycle()` was called exactly once, at boot, and the map
// was frozen for the rest of the session — a live-intelligence dashboard whose
// aircraft had not moved since the page loaded.
//
// ── why the cycle stays the unit ────────────────────────────────────────────
//
// ingest.ts argues that collecting a whole cycle before ingesting any of it is
// the invariant, not an optimisation: TxnId is insertion order, and the store's
// system-time index is only correct while `sys_from` is non-decreasing. So this
// does not stream individual feeds as they arrive. It decides which sources are
// due, hands that set to one cycle, and waits for it.
//
// ── and why it is allowed to do nothing ─────────────────────────────────────
//
// A poll that finds nothing new must commit nothing. The Ingestor's duplicate
// guard enforces that; this file's job is only to not hammer the endpoints in
// the meantime. Both halves matter: without the guard, polling would manufacture
// system-time history, and the scrubber's Y axis would become a record of how
// often the page polled.
// ────────────────────────────────────────────────────────────────────────────
import type { SourceSpec, Viewport } from '../sources/spec'
import type { IngestResult, Ingestor } from './ingest'

/** Coarse tick. A source's own `pollSeconds` is what actually paces it. */
const TICK_MS = 5_000

export interface SchedulerOptions {
  ingestor: Ingestor
  specs: readonly SourceSpec[]
  /** Where the map is looking, for viewport-scoped sources. */
  viewport: () => Viewport | undefined
  /** Called after any cycle that committed something. */
  onCycle: (result: IngestResult) => void
}

export interface SourceTiming {
  key: string
  /** Unix seconds of the last completed fetch, or null if never. */
  lastFetch: number | null
  /** Unix seconds when it next comes due, or null if it never repeats. */
  nextDue: number | null
}

export class Scheduler {
  #opts: SchedulerOptions
  #timer: ReturnType<typeof setTimeout> | null = null
  #running = false
  #inFlight = false
  #lastFetch = new Map<string, number>()
  #abort: AbortController | null = null

  constructor(opts: SchedulerOptions) {
    this.#opts = opts
  }

  /** Timings for the layer panel. Invisible polling might as well not happen. */
  timings(): SourceTiming[] {
    const now = Date.now() / 1000
    return this.#opts.specs
      .filter((s) => s.pollSeconds !== undefined)
      .map((s) => {
        const last = this.#lastFetch.get(s.key) ?? null
        return {
          key: s.key,
          lastFetch: last,
          nextDue: last === null ? now : last + (s.pollSeconds ?? 0),
        }
      })
  }

  get running(): boolean {
    return this.#running
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#timer = setTimeout(this.#tick, TICK_MS)
  }

  stop(): void {
    this.#running = false
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    // A cycle already in flight is abandoned rather than awaited: its results
    // would arrive into a tab nobody is looking at, and its fetches are the
    // thing being stopped. Polling a volunteer-funded ADS-B endpoint from a
    // background tab is precisely what this project refuses to do elsewhere.
    this.#abort?.abort()
    this.#abort = null
  }

  /** Marks a source as freshly fetched without fetching it — used at boot. */
  markFetched(keys: readonly string[], at = Date.now() / 1000): void {
    for (const k of keys) this.#lastFetch.set(k, at)
  }

  /**
   * Makes every viewport-scoped source due immediately.
   *
   * Called when the map settles somewhere new. Without it, panning to a new city
   * shows nothing until the poll interval happens to come round — up to twenty
   * seconds of an empty sky that looks exactly like a broken layer.
   */
  invalidateViewport(): void {
    for (const s of this.#opts.specs) {
      if (s.viewport !== undefined) this.#lastFetch.delete(s.key)
    }
  }

  #due(now: number): SourceSpec[] {
    return this.#opts.specs.filter((s) => {
      if (s.pollSeconds === undefined) return false
      const last = this.#lastFetch.get(s.key)
      return last === undefined || now - last >= s.pollSeconds
    })
  }

  /**
   * Derived sources due for re-derivation from their cached payload.
   *
   * Separate from `#due` because these touch no network: a TLE set is refetched
   * every six hours and re-propagated every couple of minutes, and conflating
   * the two would either hammer CelesTrak or leave the satellites frozen.
   */
  #dueForRecompute(now: number, alreadyFetching: readonly SourceSpec[]): SourceSpec[] {
    const fetching = new Set(alreadyFetching.map((s) => s.key))
    return this.#opts.specs.filter((s) => {
      if (s.recomputeSeconds === undefined || !s.derivation) return false
      // A source about to be refetched will re-derive as part of that anyway.
      if (fetching.has(s.key)) return false
      const last = this.#lastRecompute.get(s.key) ?? this.#lastFetch.get(s.key)
      return last === undefined || now - last >= s.recomputeSeconds
    })
  }

  #lastRecompute = new Map<string, number>()

  #tick = (): void => {
    this.#timer = null
    void this.#run().finally(() => {
      // Rescheduled only after the previous run resolves, so a slow cycle can
      // never overlap the next one. A fixed setInterval would queue cycles
      // behind a stalled fetch and then commit them out of order — which is the
      // one thing the system-time index cannot survive.
      if (this.#running && this.#timer === null) {
        this.#timer = setTimeout(this.#tick, TICK_MS)
      }
    })
  }

  async #run(): Promise<void> {
    if (this.#inFlight) return
    const now = Date.now() / 1000
    const due = this.#due(now)

    // Re-derivation runs synchronously and needs no network, so it happens
    // whether or not anything is due to be fetched.
    const recompute = this.#dueForRecompute(now, due)
    if (recompute.length > 0) {
      const result = this.#opts.ingestor.recompute(recompute)
      for (const s of recompute) this.#lastRecompute.set(s.key, Date.now() / 1000)
      if (result.batches > 0) this.#opts.onCycle(result)
    }

    if (due.length === 0) return

    this.#inFlight = true
    this.#abort = new AbortController()
    try {
      const view = this.#opts.viewport()
      const result = await this.#opts.ingestor.cycle({
        signal: this.#abort.signal,
        only: due,
        ...(view ? { view } : {}),
      })
      // Marked after the fetch resolves, not before: marking first would make a
      // slow or failing source look freshly polled and push its retry out.
      const at = Date.now() / 1000
      for (const s of due) {
        this.#lastFetch.set(s.key, at)
        // A fetch re-derives as a side effect, so the recompute clock restarts
        // with it — otherwise a source would re-derive again immediately after
        // every refetch, for no new information.
        if (s.recomputeSeconds !== undefined) this.#lastRecompute.set(s.key, at)
      }
      this.#opts.onCycle(result)
    } catch (err) {
      console.error('[parallax] poll cycle failed', err)
    } finally {
      this.#inFlight = false
      this.#abort = null
    }
  }
}
