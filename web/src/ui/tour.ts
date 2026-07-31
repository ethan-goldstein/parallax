// ── web/src/ui/tour.ts ──────────────────────────────────────────────────────
// A scripted minute that performs the argument instead of stating it.
//
// ── why this exists ─────────────────────────────────────────────────────────
//
// The whole project rests on one claim: that a store keeping BOTH time axes
// answers a question a normal dashboard cannot. Everything needed to see that is
// already on screen — but only if you know to drag the VERTICAL axis of a canvas
// at the bottom of the page, which nobody does. A visitor sees a globe with
// icons, concludes "map", and leaves. The demonstration was there; the
// invitation was not.
//
// So this drives the real controls. Not a video, not a diagram: it moves the
// actual scrubber, runs the actual queries through the actual planner, and reads
// the numbers back out of the store as it goes. Every figure in a caption is
// measured at the moment it is shown, which is why the captions that quote one
// are functions rather than strings.
//
// ── it has to survive the data ──────────────────────────────────────────────
//
// A tour that promises "watch this query get refused" and then isn't refused is
// worse than no tour. Each step can declare `can`, and a step that cannot
// currently be demonstrated is skipped rather than narrated over.
// ────────────────────────────────────────────────────────────────────────────
import type { Engine } from '../engine/engine'
import type { Globe } from '../render/map'
import type { AppState, Store } from '../state/app'
import type { Scrubber } from './scrubber'

export interface TourContext {
  engine: Engine
  globe: Globe
  app: Store<AppState>
  scrubber: Scrubber
  /** Opens a tab, so a step can point at the panel it is talking about. */
  openTab: (id: string) => void
  /** Runs a query through the normal path, exactly as a person would. */
  runQuery: (sql: string) => void
  clearQuery: () => void
}

/** Carried between steps, so a later caption can quote an earlier measurement. */
interface Memory {
  atLatest: number
}

interface TourStep {
  /** A function when the caption must quote something measured at that moment. */
  say: string | ((c: TourContext, m: Memory) => string)
  /** Milliseconds to hold before moving on. */
  hold: number
  /** False means the store cannot demonstrate this right now; the step is skipped. */
  can?: (c: TourContext) => boolean
  run?: (c: TourContext, m: Memory) => void | Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Points currently on screen — what the readout calls `visible`. */
function visible(c: TourContext): number {
  return Object.values(c.globe.layerCounts).reduce((a, b) => a + b, 0)
}

/**
 * Waits for a store change to reach the layer counts.
 *
 * `app.set` notifies on a microtask and the render then re-queries every layer,
 * so reading `layerCounts` on the next line returns the PREVIOUS state. That
 * raced exactly once and it mattered: the payoff caption measured the map before
 * its own restore had drawn, decided the count had not fallen, and quietly
 * printed the fallback wording instead of the numbers it exists to show.
 */
function settled(): Promise<void> {
  return new Promise((r) => setTimeout(r, 300))
}

/**
 * The script.
 *
 * Ordered so each step earns the next: what the map is, then that every point
 * carries two clocks, then the payoff — rewinding what was KNOWN rather than
 * what was true — then the refusal, which is the part nobody expects.
 */
const SCRIPT: readonly TourStep[] = [
  {
    say: 'Live open-source intelligence — aircraft, vessels, earthquakes, weather warnings, satellites. Every mark is a real fact from a named agency.',
    hold: 4200,
    run: (c) => {
      c.openTab('hazards')
      c.globe.flyTo(38, -96, 3.4)
    },
  },
  {
    say: 'Most dashboards stop there. They render the present tense, and when a value is corrected the old one is gone without a trace.',
    hold: 4000,
  },
  {
    say: 'This one keeps two clocks on every fact: when it was TRUE, and when we LEARNED it. The panel along the bottom is both axes at once.',
    hold: 4400,
  },
  {
    say: 'Horizontal is valid time. Dragging it left asks what was true earlier — most of these aircraft were not airborne two days ago, so they are simply not there.',
    hold: 4600,
    run: (c) => {
      const span = c.scrubber.validMax - c.scrubber.validMin
      // `pin`, not `setValidAt`: the follow tick would otherwise pull the axis
      // straight back to the present and the caption would describe a move the
      // viewer never saw.
      c.scrubber.pin({ validAt: c.scrubber.validMax - Math.round(span * 0.35) })
      c.app.set({ validAt: c.scrubber.state.validAt })
    },
  },
  {
    say: 'Now back to the present, and the other axis — the question a normal dashboard cannot answer. Same instant, but rewinding what we KNEW about it.',
    hold: 4600,
    run: async (c, m) => {
      // Valid time returns to now FIRST. Measuring from the rewound state would
      // compare against a map the previous step already emptied, and undersell
      // the only demonstration that matters here.
      c.scrubber.pin({ validAt: c.scrubber.validMax })
      c.app.set({ validAt: c.scrubber.state.validAt })
      await settled()

      m.atLatest = visible(c)
      c.scrubber.pin({ sysAt: Math.floor(c.app.state.sysAt * 0.25) })
      c.app.set({ sysAt: c.scrubber.state.sysAt })
      await settled()
    },
  },
  {
    // Measured, never asserted. If the count did not actually fall, the caption
    // says something true instead of repeating a claim the data did not support.
    say: (c, m) => {
      const now = visible(c)
      return m.atLatest > 0 && now < m.atLatest
        ? `${now.toLocaleString()} points, down from ${m.atLatest.toLocaleString()}. Nothing was deleted — the rest had not been reported yet. This is the map rendering an earlier state of knowledge.`
        : 'The map is rendering an earlier state of knowledge — what the feeds had told us by that transaction, not what they say now.'
    },
    hold: 5200,
  },
  {
    say: 'The engine underneath is C++20 compiled to WebAssembly. It plans every query and shows its work: the access path it chose, and where its own row estimate was wrong.',
    hold: 4800,
    run: (c) => {
      // Back to the present before querying, or the demonstration answers about
      // a past slice. `pin` clamps to the newest transaction; `release` then
      // hands the controls back tracking the clock, the way they were found.
      c.scrubber.pin({ validAt: c.scrubber.validMax, sysAt: Number.MAX_SAFE_INTEGER })
      c.scrubber.release()
      c.app.set({ validAt: c.scrubber.state.validAt, sysAt: c.scrubber.state.sysAt })
      c.openTab('query')
      c.runQuery('earthquakes where magnitude > 4.5 order by magnitude desc limit 20')
    },
  },
  {
    say: 'And it refuses questions. This one narrows to a single aircraft by callsign — the declared purpose does not permit identifying one asset, so the planner declines before reading a single row.',
    hold: 5400,
    // Verified against the live store rather than assumed: if this would not be
    // refused right now, the tour does not claim it was.
    can: (c) => c.engine.runQuery('aircraft where aircraft_label = "RCH123"').denied,
    run: (c) => c.runQuery('aircraft where aircraft_label = "RCH123"'),
  },
  {
    say: 'That refusal is itself a fact — written into the same store, on the same two axes, and readable in the engine tab. Have a look around.',
    hold: 4800,
    run: (c) => {
      c.clearQuery()
      c.openTab('engine')
    },
  },
]

export interface TourOptions {
  host: HTMLElement
  context: TourContext
  onEnd: () => void
}

export class Tour {
  #opts: TourOptions
  #cancelled = false
  #el: HTMLElement

  constructor(opts: TourOptions) {
    this.#opts = opts
    this.#el = document.createElement('div')
    this.#el.className = 'tour'
    this.#el.innerHTML = `
      <div class="tour-body">
        <p class="tour-say"></p>
        <div class="tour-foot">
          <span class="tour-dots hud-label"></span>
          <button type="button" class="tour-skip">skip</button>
        </div>
      </div>`
    opts.host.appendChild(this.#el)
    this.#el.querySelector('.tour-skip')?.addEventListener('click', () => this.stop())
  }

  stop(): void {
    if (this.#cancelled) return
    this.#cancelled = true
    this.#el.remove()
    this.#opts.onEnd()
  }

  async run(): Promise<void> {
    const c = this.#opts.context
    const mem: Memory = { atLatest: 0 }
    const sayEl = this.#el.querySelector('.tour-say')!
    const dotsEl = this.#el.querySelector('.tour-dots')!

    // Skips are resolved first so the step counter is honest about how many
    // steps the viewer is actually going to see.
    const steps = SCRIPT.filter((s) => !s.can || s.can(c))

    for (let i = 0; i < steps.length; i++) {
      if (this.#cancelled) return
      const step = steps[i]!

      try {
        await step.run?.(c, mem)
      } catch (err) {
        console.error('[parallax] tour step failed', err)
      }

      // After run(), so a caption that quotes a count reads the state the step
      // just produced rather than the one before it.
      sayEl.textContent = typeof step.say === 'function' ? step.say(c, mem) : step.say
      dotsEl.textContent = `${i + 1} / ${steps.length}`

      await sleep(step.hold)
    }

    this.stop()
  }
}
