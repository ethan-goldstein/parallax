// ── web/src/main.ts ─────────────────────────────────────────────────────────
// Wiring. Boots the engine, runs one ingest cycle, and binds the panels.
//
// Every feed, layer, attribute and sensitivity now comes from sources/index.ts.
// Nothing about a specific source appears below this line — adding a feed does
// not require touching this file.
// ────────────────────────────────────────────────────────────────────────────
import 'maplibre-gl/dist/maplibre-gl.css'

import './ui/tokens.css'
// After MapLibre's sheet, so the HUD's own tokens win where they overlap.
import './ui/app.css'

import { bootEngine, EngineBootError } from './engine/boot'
import { Engine } from './engine/engine'
import { Globe, type Basemap, type ProjectionMode } from './render/map'
import { LAYERS, layerForQuery } from './sources'
import { licenseObligations, SOURCES } from './sources/registry'
import { EntityRegistry } from './sources/batch'
import { Ingestor, registerAttributes, registerQueryNames } from './state/ingest'
import { renderAudit, type AuditLog } from './ui/audit'
import { runBenchmark } from './ui/bench'
import { renderEvidence, type MergeEvidence } from './ui/evidence'
import { renderExplain, type ExplainPlan } from './ui/explain'
import { renderInspector, renderTooltip, type InspectResult } from './ui/inspector'
import { renderLayerPanel, updateLayerCounts } from './ui/layerPanel'
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
    <div class="hud-right">
      <label class="purpose">
        <span class="hud-label">purpose</span>
        <select id="purpose">
          <option value="demonstration">demonstration</option>
          <option value="maritime-safety">maritime safety</option>
          <option value="disaster-response">disaster response</option>
        </select>
      </label>
      <div id="status" class="status hud-label">booting engine\u2026</div>
    </div>
  </header>

  <div class="query-bar">
    <input id="query" class="query-input" spellcheck="false" autocomplete="off"
           placeholder="earthquakes where magnitude > 4.5   \u2014   press Enter" />
    <div id="query-error" class="query-error" hidden></div>
    <div id="query-examples" class="query-examples"></div>
  </div>

  <aside class="rail rail-left">
    <section class="panel layers" id="layers"></section>
    <section class="panel obligations" id="obligations"></section>
  </aside>

  <aside class="rail rail-right">
    <section class="panel readout" id="readout" aria-live="polite"></section>
    <section class="panel inspector" id="inspector"></section>
    <section class="panel explain" id="explain"></section>
    <section class="panel evidence" id="evidence"></section>
    <section class="panel audit" id="audit"></section>
    <section class="panel bench" id="bench">
      <button id="bench-run" class="bench-run" type="button">run benchmark</button>
    </section>
  </aside>

  <div class="tooltip" id="tooltip" hidden></div>

  <div class="map-controls">
    <div class="seg" id="basemap-seg" role="group" aria-label="basemap">
      <button type="button" data-basemap="dark" class="on">dark</button>
      <button type="button" data-basemap="sat">satellite</button>
      <button type="button" data-basemap="live">live</button>
    </div>
    <div class="seg" id="projection-seg" role="group" aria-label="projection">
      <button type="button" data-projection="globe" class="on">3D</button>
      <button type="button" data-projection="mercator">2D</button>
    </div>
  </div>

  <footer class="hud hud-bottom">
    <div id="scrubber-host" class="scrubber-host"></div>
    <div class="attribution hud-label"><span id="engine-tag"></span></div>
  </footer>
`

const stage = document.querySelector<HTMLDivElement>('#stage')!
const statusEl = document.querySelector<HTMLDivElement>('#status')!
const readoutEl = document.querySelector<HTMLElement>('#readout')!
const layersEl = document.querySelector<HTMLElement>('#layers')!
const scrubberHost = document.querySelector<HTMLDivElement>('#scrubber-host')!
const engineTag = document.querySelector<HTMLSpanElement>('#engine-tag')!
const sourcesEl = document.querySelector<HTMLElement>('#obligations')!

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
  let engine: Engine
  try {
    const t0 = performance.now()
    engine = new Engine(await bootEngine(), MAX_POINTS)
    engineTag.textContent = `engine ${engine.version} · ${engine.buildTarget} · simd ${engine.hasSimd ? 'on' : 'off'} · boot ${(performance.now() - t0).toFixed(0)}ms`
  } catch (err) {
    fail(err instanceof EngineBootError ? err.message : 'The engine failed to start.', err)
    return
  }

  // Attributes, sensitivities and query-language names all come from the source
  // registry now. Adding a feed is one file in sources/ plus one line in
  // sources/index.ts — it is no longer possible to add one and forget to type
  // its sensitivity, because the declaration is what interns it.
  const attrs = registerAttributes(engine)
  registerQueryNames(engine, attrs)

  const purposeSelect = document.querySelector<HTMLSelectElement>('#purpose')!
  purposeSelect.addEventListener('change', () => {
    if (!engine.setPurpose(purposeSelect.value)) {
      console.error('[parallax] unknown purpose', purposeSelect.value)
    }
    // Re-run so the effect of the declaration is immediate and visible.
    if (queryInput.value.trim()) runQuery()
    refreshAudit()
  })

  const globe = new Globe({ container: stage, maxPoints: MAX_POINTS })
  for (const layer of LAYERS) globe.addLayer(layer.name, layer.visual)
  globe.start()

  // ── fetch every registered feed concurrently ─────────────────────────────
  statusEl.textContent = 'fetching feeds…'
  const registry = new EntityRegistry()
  const ingestor = new Ingestor(engine, registry, attrs)
  const { feeds, validMin, validMax, ingestMs, batches, clamped } = await ingestor.cycle()

  if (batches === 0) {
    fail('Every feed failed. Nothing to display.')
    return
  }
  if (clamped > 0) {
    // Non-monotone wall clocks would break txn_at_or_before's binary search, so
    // they are clamped — but silently clamping data is exactly the kind of thing
    // this project refuses to do without saying so.
    console.warn(`[parallax] ${clamped} batch(es) clamped forward to keep system time monotone`)
  }


  statusEl.textContent = 'LIVE'
  statusEl.classList.add('ok')

  // ── entity resolution ────────────────────────────────────────────────────
  //
  // Which layers have duplicates worth resolving is the layer's own claim — see
  // `resolveEntities` in sources/index.ts for why seismic is the one that does.
  for (const layer of LAYERS) {
    if (!layer.resolveEntities) continue
    const geo = attrs[layer.geoAttr]
    const scalar = attrs[layer.scalarAttr]
    if (geo !== undefined && scalar !== undefined) engine.resolveEntities(geo, scalar)
  }
  let evidence: MergeEvidence | null = null
  try {
    evidence = JSON.parse(engine.mergeEvidence(30)) as MergeEvidence
  } catch (err) {
    console.error('[parallax] merge evidence was not valid JSON', err)
  }
  renderEvidence(document.querySelector<HTMLElement>('#evidence')!, evidence)

  // ── attribution ──────────────────────────────────────────────────────────
  //
  // Obligations live beside the layers rather than in the footer, because they
  // are a property of which feeds are on — not chrome. The basemap adds its own
  // when it is switched to something that carries terms.
  const liveIds = feeds.filter((f) => f.count > 0).map((f) => SOURCES[f.key]!.id)

  function renderObligations(extra: readonly string[] = []): void {
    const notes = [...licenseObligations(liveIds), ...extra]
    sourcesEl.innerHTML =
      `<div class="panel-title hud-label">obligations</div>` +
      notes.map((o) => `<div class="obligation">${o}</div>`).join('')
  }
  renderObligations()

  // ── map controls ─────────────────────────────────────────────────────────
  const BASEMAP_TERMS: Partial<Record<Basemap, string>> = {
    // Surfaced only while active. Share-alike and non-commercial are real
    // obligations and this is the panel that exists to say so.
    sat:
      'Sentinel-2 cloudless 2024 by EOX IT Services GmbH — CC BY-NC-SA 4.0: ' +
      'non-commercial, and derived works inherit the licence',
  }

  function bindSegment<T extends string>(
    id: string,
    attr: string,
    apply: (value: T) => void,
  ): void {
    const host = document.querySelector<HTMLElement>(id)
    if (!host) return
    host.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.addEventListener('click', () => {
        host.querySelectorAll('button').forEach((o) => o.classList.remove('on'))
        b.classList.add('on')
        apply(b.dataset[attr] as T)
      })
    })
  }

  bindSegment<Basemap>('#basemap-seg', 'basemap', (which) => {
    globe.setBasemap(which)
    const term = BASEMAP_TERMS[which]
    renderObligations(term ? [term] : [])
  })
  bindSegment<ProjectionMode>('#projection-seg', 'projection', (mode) => {
    globe.setProjectionMode(mode)
  })

  // ── layer panel ──────────────────────────────────────────────────────────
  const visible: Record<string, boolean> = {}
  for (const layer of LAYERS) visible[layer.name] = layer.enabledByDefault ?? true

  const drawLayerPanel = (): void =>
    renderLayerPanel({
      host: layersEl,
      layers: LAYERS,
      feeds,
      visible,
      counts: globe.layerCounts,
      onToggle: (name, on) => {
        visible[name] = on
        globe.setLayerVisible(name, on)
        refresh()
      },
    })

  drawLayerPanel()

  // ── picking ──────────────────────────────────────────────────────────────
  //
  // The engine picks the row, given a position. It is never handed a fact id:
  // Store's row accessors are unchecked, so a caller-supplied index would put an
  // out-of-bounds read one typo away.
  const inspectorEl = document.querySelector<HTMLElement>('#inspector')!
  const tooltipEl = document.querySelector<HTMLElement>('#tooltip')!

  /**
   * The geometry attributes currently ON SCREEN, as the engine wants them.
   *
   * The engine has no notion of a layer being switched off and should not
   * acquire one, so the view states it. While a query is showing, only the
   * queried layer is drawn — picking has to narrow to it too, or it would
   * identify points that are not visible.
   */
  function displayedGeoAttrs(): string {
    const active = queryActive ? [layerForQuery(queryInput.value) ?? LAYERS[0]] : LAYERS
    return active
      .filter((l): l is (typeof LAYERS)[number] => !!l && visible[l.name] !== false)
      .map((l) => attrs[l.geoAttr])
      .filter((id): id is number => id !== undefined)
      .join(',')
  }

  function pick(lat: number, lon: number, radiusM: number): InspectResult | null {
    const attrList = displayedGeoAttrs()
    if (attrList.length === 0) return null
    try {
      return JSON.parse(
        engine.inspect(lat, lon, radiusM, state.validAt, state.sysAt, attrList),
      ) as InspectResult
    } catch (err) {
      console.error('[parallax] inspect was not valid JSON', err)
      return null
    }
  }

  globe.onPick((ev, kind) => {
    if (!ev) {
      renderTooltip(tooltipEl, null, null)
      return
    }
    const result = pick(ev.lat, ev.lon, ev.radiusM)

    if (kind === 'hover') {
      renderTooltip(tooltipEl, result, ev.screen)
      globe.setPickCursor(!!result?.hit)
      return
    }

    // A click on empty ocean clears the panel rather than leaving the last
    // selection pinned, which would quietly stop matching the map.
    renderInspector(inspectorEl, result)
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

    // One query per layer. `truncated` is ORed across them because the render
    // buffer is fixed-capacity and shared — an oversized result returns what
    // fits and says so rather than growing under a view JavaScript holds.
    let truncated = false
    let queries = 0

    for (const layer of LAYERS) {
      const geo = attrs[layer.geoAttr]
      const scalar = attrs[layer.scalarAttr]
      if (geo === undefined || scalar === undefined) continue

      const result = engine.queryPoints(state.validAt, state.sysAt, geo, scalar)
      globe.updateLayer(
        layer.name,
        engine.heap.pointView(result),
        visible[layer.name] === false ? 0 : result.count,
      )

      const s = engine.lastScan()
      total += result.count
      scanned += s.rowsScanned
      skipped += s.chunksSkipped
      chunks = Math.max(chunks, s.chunksTotal)
      queryMs += s.queryMs
      truncated = truncated || Boolean(result.truncated)
      queries++
    }

    // chunks are counted per query, so the denominator scales with layer count
    // rather than being hardcoded to two.
    const chunkTotal = chunks * Math.max(queries, 1)
    const skipPct = chunkTotal > 0 ? ((skipped / chunkTotal) * 100).toFixed(0) : '0'

    updateLayerCounts(layersEl, globe.layerCounts)

    readoutEl.innerHTML = [
      row('visible', total.toLocaleString(), 'ok'),
      row('facts', engine.factCount.toLocaleString()),
      row('entities', registry.size.toLocaleString()),
      row('transactions', `${state.sysAt} / ${transactions.length - 1}`, 'sys'),
      row('query', `${queryMs.toFixed(3)} ms`),
      row('rows scanned', scanned.toLocaleString()),
      row('chunks skipped', `${skipped}/${chunkTotal} · ${skipPct}%`),
      row('store', `${(engine.heapBytes / 1024).toFixed(0)} KB`),
      row('ingest', `${ingestMs.toFixed(1)} ms`),
      row('frame', `${globe.frameMs.toFixed(2)} ms`),
      truncated ? row('truncated', 'buffer full', 'bad') : '',
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

  // One example per capability worth discovering, not a feature list. The
  // aurora one is the important one: it is the only query that reaches the
  // region of the scrubber ABOVE the diagonal, because a forecast is asserted
  // before the instant it describes.
  const EXAMPLES = [
    'earthquakes where magnitude > 4.5',
    'earthquakes order by magnitude desc limit 20',
    'aurora as of +90m',
    'aircraft where altitude > 30000',
    'alerts since -24h',
    'vessels within 40km of (60.15, 24.95)',
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

  function refreshAudit(): void {
    const host = document.querySelector<HTMLElement>('#audit')
    if (!host) return
    try {
      renderAudit(host, JSON.parse(engine.auditLog(20)) as AuditLog)
    } catch (err) {
      console.error('[parallax] audit log was not valid JSON', err)
    }
  }

  /**
   * Empties every layer.
   *
   * A refused query must leave nothing on screen. Showing the previous result
   * under a refusal notice would make the refusal look cosmetic — the point of
   * a plan-time denial is that the rows were never read.
   */
  function clearLayers(buffer: Parameters<typeof engine.heap.pointView>[0]): void {
    for (const layer of LAYERS) {
      globe.updateLayer(layer.name, engine.heap.pointView(buffer), 0)
    }
  }

  function clearQuery(): void {
    queryActive = false
    queryInput.classList.remove('invalid', 'denied')
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

    // A policy refusal is NOT a syntax error. Conflating them would tell the
    // user to fix their typing when there is nothing wrong with it — the
    // query was understood perfectly and declined.
    if (result.denied) {
      queryActive = false
      queryInput.classList.remove('invalid')
      queryInput.classList.add('denied')
      queryError.hidden = false
      queryError.className = 'query-denial'
      queryError.innerHTML = `
        <div class="qd-head"><span class="qd-rule">${result.ruleId}</span> refused</div>
        <div class="qd-why">${result.denialExplanation}</div>
        <div class="qd-trigger">triggered by: ${result.denialOffending}</div>
        <div class="qd-remedy">${result.denialRemedy}</div>`
      clearLayers(result.buffer)
      renderExplain(explainHost, null)
      refreshAudit()
      return
    }

    if (!result.ok) {
      queryActive = false
      queryInput.classList.remove('denied')
      queryInput.classList.add('invalid')
      queryError.hidden = false
      queryError.className = 'query-error'

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
    queryInput.classList.remove('invalid', 'denied')
    queryError.hidden = true

    // The result set REPLACES the layers: the layer whose source was queried
    // shows it and every other is emptied, so what is on screen is exactly what
    // the query returned. Routing by source name also keeps the result in its
    // own colour ramp — a vessel query used to render in the seismic amber
    // because the buffer carries no source of its own.
    const target = layerForQuery(sql) ?? LAYERS[0]
    for (const layer of LAYERS) {
      globe.updateLayer(
        layer.name,
        engine.heap.pointView(result.buffer),
        layer.name === target?.name ? result.buffer.count : 0,
      )
    }

    let plan: ExplainPlan | null = null
    try {
      plan = JSON.parse(result.explain) as ExplainPlan
    } catch (err) {
      console.error('[parallax] EXPLAIN was not valid JSON', err)
    }
    renderExplain(explainHost, plan)
    refreshAudit()

    const scan = engine.lastScan()
    updateLayerCounts(layersEl, globe.layerCounts)

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

  refreshAudit()

  const benchHost = document.querySelector<HTMLElement>('#bench')!
  document.querySelector<HTMLButtonElement>('#bench-run')!.addEventListener('click', () => {
    runBenchmark(engine, benchHost)
  })

  Object.assign(window, {
    __parallax: { engine, globe, scrubber, refresh, runQuery, refreshAudit },
  })
}

void main()
