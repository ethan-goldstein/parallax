// ── web/src/main.ts ─────────────────────────────────────────────────────────
// Phase 3: live USGS earthquakes, ingested into the C++ bitemporal store,
// rendered from the wasm heap, scrubbable on both time axes.
// ────────────────────────────────────────────────────────────────────────────
import './ui/tokens.css'
import './ui/app.css'

import { toTimestamp } from './engine/abi'
import { bootEngine, EngineBootError } from './engine/boot'
import { Engine } from './engine/engine'
import { Globe } from './render/globe'
import {
  buildBatches,
  EntityRegistry,
  fetchQuakes,
  USGS_ATTRIBUTION,
  USGS_FEEDS,
  type Quake,
} from './sources/usgs'
import { Scrubber } from './ui/scrubber'

const MAX_POINTS = 262_144

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('#app is missing from index.html')

app.innerHTML = `
  <div id="stage" class="stage"></div>

  <header class="hud hud-top">
    <div class="brand">
      <span class="brand-mark">PARALLAX</span>
      <span class="brand-sub">bitemporal analytical engine</span>
    </div>
    <div id="status" class="status hud-label">booting engine…</div>
  </header>

  <aside id="readout" class="hud panel readout" aria-live="polite"></aside>

  <footer class="hud hud-bottom">
    <div id="scrubber-host" class="scrubber-host"></div>
    <div class="attribution hud-label">
      <span>data · <a href="${USGS_ATTRIBUTION.url}" target="_blank" rel="noopener noreferrer">${USGS_ATTRIBUTION.name}</a> · ${USGS_ATTRIBUTION.license}</span>
      <span id="engine-tag"></span>
    </div>
  </footer>
`

const stage = document.querySelector<HTMLDivElement>('#stage')!
const statusEl = document.querySelector<HTMLDivElement>('#status')!
const readoutEl = document.querySelector<HTMLElement>('#readout')!
const scrubberHost = document.querySelector<HTMLDivElement>('#scrubber-host')!
const engineTag = document.querySelector<HTMLSpanElement>('#engine-tag')!

function row(label: string, value: string, tone = ''): string {
  return `<div class="row"><span class="hud-label">${label}</span><span class="v ${tone}">${value}</span></div>`
}

function fail(message: string, err?: unknown): void {
  statusEl.textContent = 'FAILED'
  statusEl.classList.add('bad')
  readoutEl.innerHTML = row('error', message, 'bad')
  if (err) console.error('[parallax]', err)
}

async function main(): Promise<void> {
  // ── engine ───────────────────────────────────────────────────────────────
  let engine: Engine
  try {
    const t0 = performance.now()
    const module = await bootEngine()
    engine = new Engine(module, MAX_POINTS)
    engineTag.textContent = `engine ${engine.version} · ${engine.buildTarget} · simd ${engine.hasSimd ? 'on' : 'off'} · boot ${(performance.now() - t0).toFixed(0)}ms`
  } catch (err) {
    fail(
      err instanceof EngineBootError ? err.message : 'The engine failed to start.',
      err,
    )
    return
  }

  const attrs = {
    position: engine.intern('position'),
    magnitude: engine.intern('magnitude'),
    depth: engine.intern('depth'),
  }

  // ── globe ────────────────────────────────────────────────────────────────
  const globe = new Globe({ container: stage, maxPoints: MAX_POINTS })
  globe.start()

  // ── data ─────────────────────────────────────────────────────────────────
  statusEl.textContent = 'fetching USGS feed…'

  let quakes: Quake[]
  let ingestMs = 0
  try {
    const result = await fetchQuakes(USGS_FEEDS.week)
    quakes = result.quakes

    if (quakes.length === 0) {
      fail('The USGS feed returned no usable events.')
      return
    }

    const registry = new EntityRegistry()
    const batches = buildBatches(quakes, registry, attrs)

    // One transaction per revision instant, in ascending order, so the system
    // axis replays USGS's own publication history rather than an invented one.
    const t0 = performance.now()
    for (const batch of batches) {
      engine.ingest(batch.facts, batch.wallClockUnix)
    }
    ingestMs = performance.now() - t0

    statusEl.textContent = 'LIVE'
    statusEl.classList.add('ok')
  } catch (err) {
    fail(
      err instanceof TypeError
        ? 'Could not reach the USGS feed (network or CORS).'
        : `USGS fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    )
    return
  }

  // ── scrubber ─────────────────────────────────────────────────────────────
  const validTimes = quakes.map((q) => toTimestamp(q.timeUnix))
  const validMin = Math.min(...validTimes)
  const validMax = Math.max(...validTimes)

  const transactions = engine.transactions()

  let state = { validAt: validMax, sysAt: transactions.length - 1 }

  const scrubber = new Scrubber({
    container: scrubberHost,
    validMin,
    validMax,
    transactions,
    onChange: (s) => {
      state = s
      refresh()
    },
  })

  // ── render loop coupling ─────────────────────────────────────────────────

  function refresh(): void {
    const ref = engine.queryPoints(state.validAt, state.sysAt, attrs.position, attrs.magnitude)

    // Re-derive the view on every call. Never cache it — see heap.ts for what
    // happens when the heap grows under a held ArrayBuffer.
    const view = engine.heap.pointView(ref)
    globe.updateFromHeap(view, ref.count)

    const scan = engine.lastScan()
    const skipPct =
      scan.chunksTotal > 0 ? ((scan.chunksSkipped / scan.chunksTotal) * 100).toFixed(0) : '0'

    readoutEl.innerHTML = [
      row('visible', `${ref.count.toLocaleString()}`, 'ok'),
      row('facts', engine.factCount.toLocaleString()),
      row('transactions', `${state.sysAt} / ${transactions.length - 1}`, 'sys'),
      row('query', `${scan.queryMs.toFixed(3)} ms`),
      row('rows scanned', scan.rowsScanned.toLocaleString()),
      row('chunks skipped', `${scan.chunksSkipped}/${scan.chunksTotal} · ${skipPct}%`),
      row('store', `${(engine.heapBytes / 1024).toFixed(0)} KB`),
      row('ingest', `${ingestMs.toFixed(1)} ms`),
      row('frame', `${globe.frameMs.toFixed(2)} ms`),
      ref.truncated ? row('truncated', 'buffer capacity reached', 'bad') : '',
    ].join('')
  }

  refresh()

  // Frame-time readout only; the scrubber drives everything else, so there is
  // no polling loop re-querying the engine for data that has not changed.
  setInterval(() => {
    const frameCell = readoutEl.querySelector('.row:nth-last-child(1) .v')
    if (frameCell) frameCell.textContent = `${globe.frameMs.toFixed(2)} ms`
  }, 500)

  // Pause the render loop when the tab is hidden. Browsers throttle rAF
  // anyway; stopping explicitly means we are not fighting them for it.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) globe.stop()
    else globe.start()
  })

  // Expose for the E2E tests in Phase 8 and for poking at in a console.
  Object.assign(window, { __parallax: { engine, globe, scrubber, refresh } })
}

void main()
