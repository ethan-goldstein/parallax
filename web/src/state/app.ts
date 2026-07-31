// ── web/src/state/app.ts ────────────────────────────────────────────────────
// The session's view state, in one addressable place.
//
// This exists because the alternative was worse in a specific, traceable way.
// Layer visibility, the two scrubber axes and the query mode all used to live as
// plain `let`s inside main()'s closure, and the redraw function was a `let` that
// got REASSIGNED at the bottom of the file to short-circuit while a query was
// running. Nothing could observe a change, so every new interaction had to
// remember to call the redraw by hand — and the reassignment silently broke
// scrubbing in query mode for as long as it existed.
//
// Deliberately not a framework. Sixty lines of subscribe/notify is the whole
// requirement, and a dependency here would be the largest thing in a project
// whose point is that the interesting parts are hand-written.
// ────────────────────────────────────────────────────────────────────────────

/** What the query bar is currently asking, if anything. */
export interface QueryState {
  /** The query text. Its temporal axes are the scrubber's, not its own. */
  text: string

  /**
   * A query is submitted and is replacing the layer render.
   *
   * Cleared by Escape or an empty input — deliberately NOT by a query that
   * failed to parse or was refused. Those must also leave the layers hidden: a
   * refusal that quietly restored the unfiltered map would look cosmetic, when
   * the entire point of a plan-time denial is that the rows were never read.
   */
  submitted: boolean
}

export interface AppState {
  /** Layer name → drawn. The engine has no notion of a hidden layer; the view does. */
  visible: Record<string, boolean>

  /** Valid-time axis: a px::Timestamp, seconds since 2000-01-01. */
  validAt: number

  /** System-time axis: a TRANSACTION INDEX, not a clock. */
  sysAt: number

  query: QueryState
}

type Listener<T> = (state: Readonly<T>) => void

export class Store<T extends object> {
  #state: T
  #listeners = new Set<Listener<T>>()
  #queued = false

  constructor(initial: T) {
    this.#state = initial
  }

  get state(): Readonly<T> {
    return this.#state
  }

  /**
   * Shallow-merges a patch and notifies, at most once per microtask.
   *
   * The coalescing is not a micro-optimisation. A scrubber drag fires onChange
   * per pointermove, and each redraw is one engine query PER LAYER — so an
   * uncoalesced notify would run six queries for every intermediate value the
   * pointer passed through, most of which are never seen.
   *
   * Keys whose value is unchanged by Object.is are dropped, so a toggle set back
   * to what it already was does not redraw. `visible` is replaced wholesale
   * rather than mutated, which is what makes that comparison meaningful.
   */
  set(patch: Partial<T>): void {
    let changed = false
    for (const key of Object.keys(patch) as (keyof T)[]) {
      if (!Object.is(this.#state[key], patch[key])) {
        changed = true
        break
      }
    }
    if (!changed) return

    this.#state = { ...this.#state, ...patch }
    this.#schedule()
  }

  subscribe(fn: Listener<T>): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  #schedule(): void {
    if (this.#queued) return
    this.#queued = true
    queueMicrotask(() => {
      this.#queued = false
      // Snapshot first: a listener that calls set() must not mutate the set
      // being iterated, and must not be re-entered within this same flush.
      for (const fn of [...this.#listeners]) fn(this.#state)
    })
  }
}
