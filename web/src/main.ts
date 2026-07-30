// ── web/src/main.ts ─────────────────────────────────────────────────────────
// Phase 4: two live feeds, one bitemporal store, two globe layers.
// ────────────────────────────────────────────────────────────────────────────
import './ui/tokens.css'
import './ui/app.css'

import { toTimestamp } from './engine/abi'
import { bootEngine, EngineBootError } from './engine/boot'
import { Engine } from './engine/engine'
import { Globe } from './render/globe'
import { fetchVessels, buildVesselBatches } from './sources/digitraffic'
import { licenseObligations, SOURCES } from './sources/registry'
import { buildBatches, EntityRegistry, fetchQuakes, USGS_FEEDS, type Batch } from './sources/usgs'
import { renderExplain, type ExplainPlan } from './ui/explain'
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

  <div class="query-bar">
    <input id="query" class="query-input" spellcheck="false" autocomplete="off"
           placeholder="earthquakes where magnitude > 4.5   —   press Enter" />
    <div id="query-error" class="query-error" hidden></div>
    <div id="query-examples" class="query-examples"></div>
  </div>

  <section id="explain" class="explain"></section>

  <aside class="hud panel layers" id="layers"></aside>
  <aside id="readout" class="hud panel readout" aria-live="polite"></aside>

  <footer class="hud hud-bottom">
    <div id="scrubber-host" class="scrubber-host"></div>
    <div class="attribution hud-label">
      <span id="sources"></span>
      <span id="engine-tag"></span>
    </div>
  </footer>
`

const stage = document.querySelector<HTMLDivElement>('#stage')!
const statusEl = document.querySelector<HTMLDivElement>('#status')!
const readoutEl = document.querySelector<HTMLElement>('#readout')!
const layersEl = document.querySelector<HTMLElement>('#layers')!
const scrubberHost = document.querySelector<HTMLDivElement>('#scrubber-host')!
const engineTag = document.querySelector<HTMLSpanElement>('#engine-tag')!
const sourcesEl = document.querySelector<HTMLSpanElement>('#sources')!

function row(label: string, value: string, tone = ''): string {
  return `<div class="row"><span class="hud-label">${label}</span><span class="v ${tone}">${value}</span></div>`
}

function fail(message: string, err?: unknown): void {
  statusEl.textContent = 'FAILED'
  statusEl.classList.add('bad')
  readoutEl.innerHTML = row('error', message, 'bad')
  if (err) console.error('[parallax]', err)
}

/** A feed that failed is reported, never silently dropped. */
interface FeedStatus {
  key: string
  label: string
  layer: string
  count: number
  error?: string
}

async function main(): Promise<void> {
  let engine: Engine
  try {
    const t0 = performance.now()
    engine = new Engine(await bootEngine(), MAX_POINTS)
    engineTag.textContent = `engine ${engine.version} · ${engine.buildTarget} · simd ${engine.hasSimd ? 'on' : 'off'} · boot ${(performance.now() - t0).toFixed(0)}ms`
  } catch (err) {
    fail(err instanceof EngineBootError ? err.message : 'The engine failed to start.', err)
    return
  }

  const attrs = {
    position: engine.intern('position'),
    magnitude: engine.intern('magnitude'),
    depth: engine.intern('depth'),
    vesselPosition: engine.intern('vessel_position'),
    speed: engine.intern('speed'),
  }

  // Bind query-language source names to the attributes that carry their
  // geometry and scalar, so `earthquakes` and `vessels` mean different things
  // to the planner.
  engine.registerSource('earthquakes', attrs.position, attrs.magnitude)
  engine.registerSource('quakes', attrs.position, attrs.magnitude)
  engine.registerSource('vessels', attrs.vesselPosition, attrs.speed)
  engine.registerSource('ships', attrs.vesselPosition, attrs.speed)

  const globe = new Globe({ container: stage, maxPoints: MAX_POINTS })
  // Amber → red for seismic energy; teal for maritime. Teal is the valid-time
  // colour, and vessel positions sit exactly on the scrubber's diagonal (see
  // digitraffic.ts) — the colour is making that point, not decorating.
  globe.addLayer('seismic', {
    colorLow: 0xffb000,
    colorHigh: 0xe5484d,
    sizeBase: 0.006,
    sizeScale: 0.0045,
    rampLow: 2.5,
    rampHigh: 6.5,
  })
  globe.addLayer('maritime', {
    colorLow: 0x3fd0c9,
    colorHigh: 0xe8e6e1,
    sizeBase: 0.0035,
    sizeScale: 0.00035,
    rampLow: 0,
    rampHigh: 20,
  })
  globe.start()

  // ── fetch both feeds concurrently ────────────────────────────────────────
  statusEl.textContent = 'fetching feeds…'
  const registry = new EntityRegistry()
  const feeds: FeedStatus[] = []
  let allBatches: Batch[] = []
  let validMin = Number.POSITIVE_INFINITY
  let validMax = Number.NEGATIVE_INFINITY

  // allSettled, not all: one dead feed must degrade the map, not blank it.
  const [quakeRes, vesselRes] = await Promise.allSettled([
    fetchQuakes(USGS_FEEDS.week),
    fetchVessels(),
  ])

  if (quakeRes.status === 'fulfilled' && quakeRes.value.quakes.length > 0) {
    const q = quakeRes.value.quakes
    allBatches = allBatches.concat(buildBatches(q, registry, attrs))
    for (const x of q) {
      const t = toTimestamp(x.timeUnix)
      if (t < validMin) validMin = t
      if (t > validMax) validMax = t
    }
    feeds.push({ key: 'usgs', label: 'seismic', layer: 'seismic', count: q.length })
  } else {
    feeds.push({
      key: 'usgs',
      label: 'seismic',
      layer: 'seismic',
      count: 0,
      error: quakeRes.status === 'rejected' ? String(quakeRes.reason).slice(0, 60) : 'no events',
    })
  }

  if (vesselRes.status === 'fulfilled' && vesselRes.value.vessels.length > 0) {
    const v = vesselRes.value.vessels
    allBatches = allBatches.concat(
      buildVesselBatches(v, registry, { position: attrs.vesselPosition, speed: attrs.speed }),
    )
    for (const x of v) {
      const t = toTimestamp(x.timeUnix)
      if (t < validMin) validMin = t
      if (t > validMax) validMax = t
    }
    feeds.push({ key: 'digitraffic', label: 'maritime', layer: 'maritime', count: v.length })
  } else {
    feeds.push({
      key: 'digitraffic',
      label: 'maritime',
      layer: 'maritime',
      count: 0,
      error:
        vesselRes.status === 'rejected' ? String(vesselRes.reason).slice(0, 60) : 'no vessels',
    })
  }

  if (allBatches.length === 0) {
    fail('Every feed failed. Nothing to display.')
    return
  }

  // ── ingest, in GLOBAL wall-clock order ───────────────────────────────────
  //
  // This sort is load-bearing, not tidiness. TxnId is assigned by insertion
  // order, and the store's system-time index depends on sys_from being
  // non-decreasing — that is what makes the binary search in
  // Store::upper_row_for_txn correct. Ingesting all of one feed and then all
  // of another would interleave wall clocks against transaction order, so
  // scrubbing to "as known at 14:00" would show a 14:30 vessel beside a 13:00
  // quake. Merging both feeds into one ascending timeline is what keeps the
  // system axis meaning one thing across sources.
  allBatches.sort((a, b) => a.wallClockUnix - b.wallClockUnix)

  const t0 = performance.now()
  for (const batch of allBatches) engine.ingest(batch.facts, batch.wallClockUnix)
  const ingestMs = performance.now() - t0

  statusEl.textContent = 'LIVE'
  statusEl.classList.add('ok')

  // ── attribution ──────────────────────────────────────────────────────────
  const liveIds = feeds.filter((f) => f.count > 0).map((f) => SOURCES[f.key]!.id)
  sourcesEl.innerHTML = licenseObligations(liveIds)
    .map((o) => `<span class="obligation">${o}</span>`)
    .join(' · ')

  // ── layer panel ──────────────────────────────────────────────────────────
  const visible: Record<string, boolean> = { seismic: true, maritime: true }
  layersEl.innerHTML = feeds
    .map(
      (f) => `
      <label class="layer-row ${f.error ? 'dead' : ''}">
        <input type="checkbox" data-layer="${f.layer}" ${f.error ? 'disabled' : 'checked'} />
        <span class="hud-label">${f.label}</span>
        <span class="v ${f.error ? 'bad' : ''}">${f.error ? 'unavailable' : f.count.toLocaleString()}</span>
      </label>`,
    )
    .join('')

  layersEl.querySelectorAll<HTMLInputElement>('input[data-layer]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const name = cb.dataset.layer!
      visible[name] = cb.checked
      globe.setLayerVisible(name, cb.checked)
      refresh()
    })
  })

  // ── scrubber ─────────────────────────────────────────────────────────────
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

  let refresh = function (): void {
    let total = 0
    let scanned = 0
    let skipped = 0
    let chunks = 0
    let queryMs = 0

    const seismic = engine.queryPoints(state.validAt, state.sysAt, attrs.position, attrs.magnitude)
    globe.updateLayer('seismic', engine.heap.pointView(seismic), visible.seismic ? seismic.count : 0)
    {
      const s = engine.lastScan()
      total += seismic.count
      scanned += s.rowsScanned
      skipped += s.chunksSkipped
      chunks = Math.max(chunks, s.chunksTotal)
      queryMs += s.queryMs
    }

    const maritime = engine.queryPoints(
      state.validAt,
      state.sysAt,
      attrs.vesselPosition,
      attrs.speed,
    )
    globe.updateLayer(
      'maritime',
      engine.heap.pointView(maritime),
      visible.maritime ? maritime.count : 0,
    )
    {
      const s = engine.lastScan()
      total += maritime.count
      scanned += s.rowsScanned
      skipped += s.chunksSkipped
      chunks = Math.max(chunks, s.chunksTotal)
      queryMs += s.queryMs
    }

    const skipPct = chunks > 0 ? ((skipped / (chunks * 2)) * 100).toFixed(0) : '0'

    readoutEl.innerHTML = [
      row('visible', total.toLocaleString(), 'ok'),
      row('facts', engine.factCount.toLocaleString()),
      row('entities', registry.size.toLocaleString()),
      row('transactions', `${state.sysAt} / ${transactions.length - 1}`, 'sys'),
      row('query', `${queryMs.toFixed(3)} ms`),
      row('rows scanned', scanned.toLocaleString()),
      row('chunks skipped', `${skipped}/${chunks * 2} · ${skipPct}%`),
      row('store', `${(engine.heapBytes / 1024).toFixed(0)} KB`),
      row('ingest', `${ingestMs.toFixed(1)} ms`),
      row('frame', `${globe.frameMs.toFixed(2)} ms`),
      seismic.truncated || maritime.truncated ? row('truncated', 'buffer full', 'bad') : '',
    ].join('')
  }

  refresh()

  setInterval(() => {
    const cell = readoutEl.querySelector('.row:last-child .v')
    if (cell && cell.previousElementSibling?.textContent === 'frame') {
      cell.textContent = `${globe.frameMs.toFixed(2)} ms`
    }
  }, 500)

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) globe.stop()
    else globe.start()
  })

  // ── query bar ────────────────────────────────────────────────────────────
  //
  // A query REPLACES the layer rendering: when one is active the globe shows
  // its result set and nothing else, because showing query results on top of
  // an unfiltered background would make it impossible to tell which points the
  // query actually selected.
  const queryInput = document.querySelector<HTMLInputElement>('#query')!
  const queryError = document.querySelector<HTMLDivElement>('#query-error')!
  const explainHost = document.querySelector<HTMLElement>('#explain')!
  const examplesHost = document.querySelector<HTMLDivElement>('#query-examples')!

  const EXAMPLES = [
    'earthquakes where magnitude > 4.5',
    'earthquakes in bbox(30, 120, 50, 150)',
    'vessels within 40km of (60.15, 24.95)',
    'earthquakes where magnitude > 5 limit 20',
  ]
  examplesHost.innerHTML = EXAMPLES.map(
    (e) => `<button class="query-example" type="button">${e}</button>`,
  ).join('')
  examplesHost.querySelectorAll<HTMLButtonElement>('.query-example').forEach((b, i) => {
    b.addEventListener('click', () => {
      queryInput.value = EXAMPLES[i]!
      runQuery()
    })
  })

  let queryActive = false

  function clearQuery(): void {
    queryActive = false
    queryInput.classList.remove('invalid')
    queryError.hidden = true
    renderExplain(explainHost, null)
    refresh()
  }

  function runQuery(): void {
    const sql = queryInput.value.trim()
    if (sql.length === 0) {
      clearQuery()
      return
    }

    const result = engine.runQuery(sql)

    if (!result.ok) {
      queryActive = false
      queryInput.classList.add('invalid')
      queryError.hidden = false

      // The engine returns a byte span for the offending token, so point at it
      // rather than saying "syntax error" and leaving the user to hunt.
      const caret =
        ' '.repeat(Math.max(0, result.errorBegin)) +
        '^'.repeat(Math.max(1, result.errorEnd - result.errorBegin))
      queryError.innerHTML =
        `<div>${result.error}</div><div class="caret">${sql}</div><div class="caret">${caret}</div>`
      renderExplain(explainHost, null)
      return
    }

    queryActive = true
    queryInput.classList.remove('invalid')
    queryError.hidden = true

    // The result set is a single layer; the other is emptied so what is on
    // screen is exactly what the query returned.
    globe.updateLayer('seismic', engine.heap.pointView(result.buffer), result.buffer.count)
    globe.updateLayer('maritime', engine.heap.pointView(result.buffer), 0)

    let plan: ExplainPlan | null = null
    try {
      plan = JSON.parse(result.explain) as ExplainPlan
    } catch (err) {
      console.error('[parallax] EXPLAIN was not valid JSON', err)
    }
    renderExplain(explainHost, plan)

    const scan = engine.lastScan()
    readoutEl.innerHTML = [
      row('query rows', result.buffer.count.toLocaleString(), 'ok'),
      row('facts', engine.factCount.toLocaleString()),
      row('entities', registry.size.toLocaleString()),
      row('plan', plan ? `${plan.rejected.length + 1} paths considered` : '—'),
      row('engine', `${scan.queryMs.toFixed(3)} ms`),
      row('store', `${(engine.heapBytes / 1024).toFixed(0)} KB`),
      row('frame', `${globe.frameMs.toFixed(2)} ms`),
      result.buffer.truncated ? row('truncated', 'buffer full', 'bad') : '',
    ].join('')
  }

  queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      runQuery()
    } else if (e.key === 'Escape') {
      queryInput.value = ''
      clearQuery()
      queryInput.blur()
    }
  })

  // Scrubbing while a query is active re-runs it, so the two time axes and the
  // query language stay the same mechanism rather than competing ones.
  const baseRefresh = refresh
  refresh = function () {
    if (queryActive) return
    baseRefresh()
  }

  Object.assign(window, { __parallax: { engine, globe, scrubber, refresh, runQuery } })
}

void main()
