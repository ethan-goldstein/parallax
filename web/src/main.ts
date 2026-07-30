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

  function refresh(): void {
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

  Object.assign(window, { __parallax: { engine, globe, scrubber, refresh } })
}

void main()
