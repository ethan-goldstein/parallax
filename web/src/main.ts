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

import { toTimestamp } from './engine/abi'
import { bootEngine, EngineBootError } from './engine/boot'
import { Engine } from './engine/engine'
import { Globe, type Basemap, type ProjectionMode } from './render/map'
import { LAYERS, layerForQuery, SOURCE_SPECS } from './sources'
import { licenseObligations, SOURCES } from './sources/registry'
import { CATEGORIES } from './sources/spec'
import { EntityRegistry } from './sources/batch'
import { Store, type AppState } from './state/app'
import { RECON_ATTRIBUTES } from './sources/recon/probes'
import { Ingestor, registerAttributes, registerQueryNames } from './state/ingest'
import { Scheduler } from './state/scheduler'
import { renderAudit, type AuditLog } from './ui/audit'
import { runBenchmark } from './ui/bench'
import { renderEvidence, type MergeEvidence } from './ui/evidence'
import { renderExplain, type ExplainPlan } from './ui/explain'
import { renderInspector, renderTooltip, type InspectResult } from './ui/inspector'
import { renderLayerPanel, updateLayerCounts } from './ui/layerPanel'
import { Scrubber } from './ui/scrubber'
import { QueryBuilder } from './ui/queryBuilder'
import { hasAsOf } from './ui/queryBuilder/compile'
import { buildReconBatch, ReconPanel } from './ui/recon'
import { buildShell } from './ui/shell'
import { TabRail, type TabDef } from './ui/tabs'

const MAX_POINTS = 262_144

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('#app is missing from index.html')

const shell = buildShell(app)
const {
  stage,
  status: statusEl,
  tabrail: tabrailEl,
  dock: dockEl,
  readout: readoutEl,
  scrubberHost,
  engineTag,
} = shell

// `data-metric` is what the live frame timer finds the cell by. It used to walk
// to `.row:last-child` and check the label of its previous sibling, which meant
// the counter silently froze whenever a `truncated` or `render` row appeared —
// exactly when something was wrong and the number mattered most.
function row(label: string, value: string, tone = ''): string {
  return `<div class="row"><span class="hud-label">${label}</span><span class="v ${tone}" data-metric="${label}">${value}</span></div>`
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
  const attrs = registerAttributes(engine, SOURCE_SPECS, RECON_ATTRIBUTES)
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
  let { feeds, validMin, validMax, ingestMs, batches, clamped } = await ingestor.cycle()

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

  // ── session state ────────────────────────────────────────────────────────
  //
  // One store, subscribed to once, rather than a handful of closure variables
  // that every new interaction had to remember to redraw by hand.
  // `let`, and never mutated in place. It used to be a const array updated with
  // `transactions.length = 0; push(...)` — but the scrubber holds a reference to
  // that same array, so by the time `setTransactions` asked "was the user at the
  // newest transaction?" the length had already grown and the answer was always
  // no. The system axis silently stopped following, and every layer whose facts
  // arrived after that point became invisible.
  let transactions = engine.transactions()

  // NOW, not validMax. See ScrubberOptions.validAt: validMax is the furthest
  // instant any fact claims, and a forecast pushes that into the future.
  const nowValid = Math.min(Math.max(toTimestamp(Date.now() / 1000), validMin), validMax)

  const app = new Store<AppState>({
    visible: Object.fromEntries(LAYERS.map((l) => [l.name, l.enabledByDefault ?? true])),
    validAt: nowValid,
    sysAt: Math.max(0, transactions.length - 1),
    query: { text: '', submitted: false },
  })

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
  // ── attribution ──────────────────────────────────────────────────────────
  //
  // Obligations live beside the layers rather than in the footer, because they
  // are a property of which feeds are on — not chrome. Now that layers are
  // grouped into tabs, each tab carries the obligations of ITS OWN sources,
  // which is what that argument implies once there is somewhere to put it.
  //
  // The basemap's terms are not a property of any category, so they go on every
  // tab while that basemap is active — an obligation shown only on the tab a
  // viewer happens not to have open is not shown.
  let basemapTerms: readonly string[] = []

  function renderObligations(): void {
    for (const c of populated) {
      const host = dockEl.querySelector<HTMLElement>(`[data-obligations="${c}"]`)
      if (!host) continue
      const ids = feeds
        .filter((f) => f.count > 0 && f.category === c)
        .map((f) => SOURCES[f.key]!.id)
      const notes = [...licenseObligations(ids), ...basemapTerms]
      host.innerHTML = notes.length
        ? `<div class="panel-title hud-label">obligations</div>` +
          notes.map((o) => `<div class="obligation">${o}</div>`).join('')
        : ''
    }
  }

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
    basemapTerms = term ? [term] : []
    renderObligations()
  })
  bindSegment<ProjectionMode>('#projection-seg', 'projection', (mode) => {
    globe.setProjectionMode(mode)
  })

  // Assigned once polling is wired, below. Declared here because the layer panel
  // reads its timings and is drawn before then — a `const` would be in its
  // temporal dead zone at that first draw.
  let scheduler: Scheduler | null = null

  // ── tabs ─────────────────────────────────────────────────────────────────
  //
  // One tab per populated category, then the tools. Built from the registry
  // rather than listed by hand, so a category with no layers cannot produce an
  // empty tab and a new layer cannot arrive without somewhere to live.
  //
  // The accent is taken from the first layer in the category — the same
  // `colorHigh` the shader interpolates to. Reading it here rather than picking
  // a colour per tab is the argument layerPanel.ts makes about the legend: a
  // second copy of a colour is a copy that can drift.
  const populated = CATEGORIES.filter((c) => LAYERS.some((l) => l.category === c))

  const TABS: TabDef[] = [
    ...populated.map((c): TabDef => {
      const first = LAYERS.find((l) => l.category === c)!
      return {
        id: c,
        // `network` is the category's internal name; RECON is what it does.
        label: c === 'network' ? 'recon' : c,
        icon: c,
        group: 'data',
        accent: `#${first.visual.colorHigh.toString(16).padStart(6, '0')}`,
      }
    }),
    { id: 'query', label: 'query', icon: 'query', group: 'tools' },
    { id: 'engine', label: 'engine', icon: 'engine', group: 'tools' },
  ]

  const tabs = new TabRail({
    rail: tabrailEl,
    dock: dockEl,
    tabs: TABS,
    // Opens on the first data tab: a viewer who has just watched a globe fill
    // with points wants to know what the points are, not to configure anything.
    // Under 1100px the dock covers the map, so it starts closed instead.
    initial: window.matchMedia('(max-width: 1100px)').matches ? null : (populated[0] ?? null),
  })

  for (const c of populated) {
    // `network` gets the lookup controls above its layer block. One tab rather
    // than two: the recon panel and the `lookups` layer are the same idea seen
    // from two sides, and splitting them would put the control that creates the
    // data somewhere other than the data.
    tabs.paneFor(c).innerHTML =
      (c === 'network' ? `<div id="recon-host"></div>` : '') +
      `<section class="panel layers" data-layers="${c}"></section>` +
      `<section class="panel obligations" data-obligations="${c}"></section>`
  }

  // The builder is the front door and the console is the escape hatch, rather
  // than the other way round. The compiled text is the bridge between them: what
  // the controls wrote is exactly what the box accepts.
  tabs.paneFor('query').innerHTML = `
    <div id="qb-host"></div>
    <details class="qb-console">
      <summary class="hud-label">or write it by hand</summary>
      <div class="query-bar">
        <input id="query" class="query-input" spellcheck="false" autocomplete="off"
               placeholder="earthquakes where magnitude > 4.5" />
        <div id="query-error" class="query-error" hidden></div>
        <div id="query-examples" class="query-examples"></div>
      </div>
    </details>
    <section class="panel explain" id="explain"></section>`

  tabs.paneFor('engine').innerHTML = `
    <section class="panel audit" id="audit"></section>
    <section class="panel evidence" id="evidence"></section>
    <section class="panel bench" id="bench">
      <button id="bench-run" class="bench-run" type="button">run benchmark</button>
    </section>`

  const drawLayerPanel = (): void => {
    const timings = new Map(scheduler?.timings().map((t) => [t.key, t]) ?? [])
    for (const c of populated) {
      renderLayerPanel({
        host: dockEl.querySelector<HTMLElement>(`[data-layers="${c}"]`)!,
        layers: LAYERS,
        category: c,
        feeds,
        timings,
        visible: app.state.visible,
        counts: globe.layerCounts,
        onToggle: (name, on) => {
          globe.setLayerVisible(name, on)
          // Replaced rather than mutated, so the store's identity check can tell
          // a real change from a toggle set back to what it already was.
          app.set({ visible: { ...app.state.visible, [name]: on } })
        },
      })
    }
  }

  drawLayerPanel()
  renderObligations()
  // Rendered once, after the pane that hosts it exists. Entity resolution runs
  // at boot over the whole store and is not re-run, so neither is this.
  renderEvidence(dockEl.querySelector<HTMLElement>('#evidence')!, evidence)

  // ── picking ──────────────────────────────────────────────────────────────
  //
  // The engine picks the row, given a position. It is never handed a fact id:
  // Store's row accessors are unchecked, so a caller-supplied index would put an
  // out-of-bounds read one typo away.
  //
  // The inspector is in the right rail, NOT in a tab: a click on the map has to
  // answer regardless of which panel happens to be open, and a click that
  // silently populated a hidden tab would read as a click that did nothing.
  const inspectorEl = shell.inspector
  const tooltipEl = shell.tooltip

  /**
   * The geometry attributes currently ON SCREEN, as the engine wants them.
   *
   * The engine has no notion of a layer being switched off and should not
   * acquire one, so the view states it. While a query is showing, only the
   * queried layer is drawn — picking has to narrow to it too, or it would
   * identify points that are not visible.
   */
  function displayedGeoAttrs(): string {
    const { query, visible } = app.state
    const active = query.submitted ? [layerForQuery(query.text) ?? LAYERS[0]] : LAYERS
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
        engine.inspect(lat, lon, radiusM, app.state.validAt, app.state.sysAt, attrList),
      ) as InspectResult
    } catch (err) {
      console.error('[parallax] inspect was not valid JSON', err)
      return null
    }
  }

  /**
   * Set while the query builder is waiting for a coordinate.
   *
   * The next map click fills in a lat/lon instead of inspecting a point. One
   * click, then it disarms — an armed mode you have to remember to leave is a
   * mode that eats the click you meant for something else.
   */
  let pendingPick: ((lat: number, lon: number) => void) | null = null

  globe.onPick((ev, kind) => {
    if (!ev) {
      renderTooltip(tooltipEl, null, null)
      return
    }

    if (kind !== 'hover' && pendingPick) {
      const cb = pendingPick
      pendingPick = null
      cb(ev.lat, ev.lon)
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
  const scrubber = new Scrubber({
    container: scrubberHost,
    validMin,
    validMax,
    validAt: nowValid,
    transactions,
    onChange: (s) => app.set({ validAt: s.validAt, sysAt: s.sysAt }),
  })

  function renderLayers(): void {
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

    const { validAt, sysAt, visible } = app.state

    for (const layer of LAYERS) {
      const geo = attrs[layer.geoAttr]
      const scalar = attrs[layer.scalarAttr]
      if (geo === undefined || scalar === undefined) continue

      const result = engine.queryPoints(validAt, sysAt, geo, scalar)
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

    updateLayerCounts(dockEl, globe.layerCounts)

    readoutEl.innerHTML = [
      row('visible', total.toLocaleString(), 'ok'),
      row('facts', engine.factCount.toLocaleString()),
      row('entities', registry.size.toLocaleString()),
      row('transactions', `${sysAt} / ${transactions.length - 1}`, 'sys'),
      row('query', `${queryMs.toFixed(3)} ms`),
      row('rows scanned', scanned.toLocaleString()),
      row('chunks skipped', `${skipped}/${chunkTotal} · ${skipPct}%`),
      row('store', `${(engine.heapBytes / 1024).toFixed(0)} KB`),
      row('ingest', `${ingestMs.toFixed(1)} ms`),
      row('frame', `${globe.frameMs.toFixed(2)} ms`),
      truncated ? row('truncated', 'buffer full', 'bad') : '',
      // Only appears when something is actually wrong. A map that renders
      // nothing should say so rather than looking like an empty world.
      globe.renderFault ? row('render', globe.renderFault, 'bad') : '',
    ].join('')
  }

  /**
   * The single redraw path.
   *
   * A submitted query REPLACES the layer render — showing results on top of an
   * unfiltered background would make it impossible to tell which points the
   * query selected — so exactly one of these two runs.
   *
   * This used to be a `let` that got reassigned at the bottom of the file to
   * return early while a query was active, which meant dragging either time axis
   * did nothing at all in the mode a visitor is most likely to be in. The two
   * axes and the query language are the same mechanism, and this is where that
   * stops being a claim in a comment.
   */
  // Declared before the first render() and assigned once the query pane exists.
  // A `const` here would be in its temporal dead zone at that first call, and
  // `?.` does not guard against that — it throws before the optional chain is
  // ever evaluated.
  let builder: QueryBuilder | null = null

  function render(): void {
    const { query, validAt, sysAt } = app.state
    builder?.setTemporal(validAt, sysAt, transactions.length)

    if (!query.submitted) {
      renderLayers()
      return
    }
    // A query carrying its own `as of` is not driven by the scrubber — the text
    // said where in time it wants to be, and overriding that would make the
    // language a liar. Since moving the axes cannot change its result, re-running
    // it on a scrub would burn a query to produce identical rows.
    if (hasAsOf(query.text) && !askedByUser) return
    executeQuery(query.text)
  }

  app.subscribe(render)
  render()

  /**
   * Walks the valid axis forward with the clock.
   *
   * The present is not an event, so nothing else would advance it: `validAt` was
   * only updated when an ingest cycle happened to commit something, and a cycle
   * that finds nothing new commits nothing — by design. So the axis fell behind
   * real time, and every layer whose facts are valid only around now drained
   * away as it did. Measured at 92 seconds behind: 8 of 408 civil aircraft still
   * within their validity window, on a feed returning all 408.
   *
   * Stops the moment a human touches the axis. They are looking at a particular
   * instant and dragging them back to the present would destroy it.
   */
  setInterval(() => {
    const patch: Partial<AppState> = {}

    if (scrubber.followingNow) {
      const next = Math.min(
        Math.max(toTimestamp(Date.now() / 1000), scrubber.validMin),
        scrubber.validMax,
      )
      if (next !== app.state.validAt) {
        scrubber.setValidAt(next)
        patch.validAt = next
      }
    }

    // The system axis follows too, and from here rather than from the ingest
    // callback. Deciding it there meant it only advanced on the code path that
    // happened to commit — so a recompute, or a cycle whose result went through
    // a different branch, left the axis parked behind the newest transaction and
    // every fact committed after it invisible. Polled state is polled state.
    const latest = engine.transactions()
    if (latest.length !== transactions.length) {
      transactions = latest
      scrubber.setTransactions(latest, scrubber.validMin, scrubber.validMax, true, undefined)
      drawLayerPanel()
    }
    if (scrubber.state.sysAt !== app.state.sysAt) patch.sysAt = scrubber.state.sysAt

    if (Object.keys(patch).length > 0) app.set(patch)
  }, 2000)

  let lastFault = globe.renderFault
  setInterval(() => {
    const cell = readoutEl.querySelector('[data-metric="frame"]')
    if (cell) cell.textContent = `${globe.frameMs.toFixed(2)} ms`

    // The render fault is the one thing on the readout that is not in the store,
    // so nothing else would notice it changing. It matters in both directions:
    // MapLibre briefly detaches the custom layers while reloading a style after
    // a resize, and without this the resulting red line stayed on screen for the
    // rest of the session — a stale alarm, which is worse than no alarm.
    if (globe.renderFault !== lastFault) {
      lastFault = globe.renderFault
      render()
    }
  }, 500)

  // ── polling ──────────────────────────────────────────────────────────────
  //
  // Until now `cycle()` ran exactly once, at boot, and the map was frozen for the
  // rest of the session. The scheduler decides what is due; the Ingestor's
  // duplicate guard decides whether anything new arrived. Both are needed: a poll
  // that found nothing must commit nothing, or the system axis would become a
  // record of how often the page polled rather than of what was learned.
  scheduler = new Scheduler({
    ingestor,
    specs: SOURCE_SPECS,
    viewport: () => globe.viewport() ?? undefined,
    onCycle: (result) => {
      if (result.batches === 0) {
        // Nothing new. Redraw the timings so "next in 8s" keeps counting, and
        // leave the store — and the scrubber's axis — exactly as they were.
        drawLayerPanel()
        return
      }
      // MERGED by key, not replaced. A poll cycle only fetches what is due, so
      // its `feeds` describes a subset — assigning it wholesale dropped every
      // boot-only source from the panel, and the ports layer went from 68 points
      // on the map to a disabled checkbox reading "—" while still being drawn.
      const byKey = new Map(feeds.map((f) => [f.key, f]))
      for (const f of result.feeds) byKey.set(f.key, f)
      feeds = [...byKey.values()]
      ingestMs = result.ingestMs
      clamped += result.clamped
      const txns = engine.transactions()
      // `follow` keeps a viewer pinned to the newest transaction only if they
      // were already there. Someone parked mid-history is examining something,
      // and yanking them to the present would destroy it.
      // Only the AXIS BOUNDS are updated here — where the axes are POINTING is
      // decided by the two-second tick above, which is the one place that knows
      // about the clock. Splitting that decision across both was how the system
      // axis ended up frozen five transactions behind the store.
      scrubber.setTransactions(
        txns,
        result.validMin,
        result.validMax,
        true,
        Math.min(Math.max(toTimestamp(Date.now() / 1000), result.validMin), result.validMax),
      )
      transactions = txns
      drawLayerPanel()
      renderObligations()
      app.set({ validAt: scrubber.state.validAt, sysAt: scrubber.state.sysAt })
    },
  })

  // Boot already fetched everything, so nothing is due for a full interval.
  scheduler.markFetched(SOURCE_SPECS.map((s) => s.key))
  scheduler.start()

  // Panning to a new city must load that city's traffic now, not whenever the
  // twenty-second timer next comes round. `moveend` already debounces the
  // gesture; this only marks the source due and lets the normal cycle run.
  globe.onViewportSettled(() => scheduler?.invalidateViewport())

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      globe.stop()
      // A background tab hammering a volunteer-funded ADS-B service is exactly
      // what this project refuses to do elsewhere.
      scheduler.stop()
      return
    }
    scheduler.start()
    // Re-measure before spinning again. MapLibre's ResizeObserver does not fire
    // on a hidden document, so a tab opened in the background comes back with the
    // container's boot-time size — which was zero.
    globe.resize()
    globe.start()
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

  // ── the builder ──────────────────────────────────────────────────────────
  const consoleEl = dockEl.querySelector<HTMLDetailsElement>('.qb-console')!

  builder = new QueryBuilder({
    host: dockEl.querySelector<HTMLElement>('#qb-host')!,
    layers: LAYERS,
    onRun: (sql) => {
      queryInput.value = sql
      runQuery()
    },
    // Hands the compiled text to the console and opens it. This is the whole
    // argument for generating the query rather than hiding it: the controls and
    // the language are the same thing, and here is where a visitor finds that out.
    onEdit: (sql) => {
      queryInput.value = sql
      consoleEl.open = true
      queryInput.focus()
      queryInput.setSelectionRange(sql.length, sql.length)
    },
    onPickPoint: (cb) => {
      pendingPick = cb
    },
  })

  // The builder is created after the boot render, so it has to be told where the
  // axes are once rather than waiting for the first thing that moves them.
  builder.setTemporal(app.state.validAt, app.state.sysAt, transactions.length)

  // ── recon ────────────────────────────────────────────────────────────────
  //
  // A lookup goes through the SAME Ingestor as every feed, so the monotonic
  // clamp and the duplicate guard hold for it too. A second ingest path would be
  // a second set of invariants, and one of them would drift.
  new ReconPanel({
    host: dockEl.querySelector<HTMLElement>('#recon-host')!,
    onResult: (result) => {
      const batch = buildReconBatch(
        result,
        registry,
        { position: attrs.recon_position!, label: attrs.recon_label! },
        (text) => engine.intern(text),
      )
      const out = ingestor.ingestOne(batch)
      if (out.committed > 0) {
        // A lookup is exactly the kind of event the licence panel exists for:
        // Shodan's InternetDB is non-commercial, and asking for it is what makes
        // that obligation apply. So the obligations update in response to it.
        const key = SOURCES.recon!.key
        if (!feeds.some((f) => f.key === key)) {
          feeds = [
            ...feeds,
            {
              key,
              label: 'lookups · recon',
              layer: 'recon',
              category: 'network',
              count: 0,
              coverageNote: 'only what you look up — nothing here arrives on its own',
            },
          ]
        }
        const entry = feeds.find((f) => f.key === key)
        if (entry) entry.count += 1
        renderObligations()
        drawLayerPanel()
        render()
      }
      return out
    },
    onLocate: (lat, lon) => globe.flyTo(lat, lon),
  })

  /**
   * Set for exactly one execution, by the path where a human asked something.
   *
   * The engine records every allowed query as facts in the store, and a scrubber
   * drag re-asks the current query at sixty instants a second. Recording each of
   * those would bury the audit trail under its own noise — so a re-run driven by
   * the axes moving is executed and policy-checked exactly as before, and simply
   * not written down. Refusals are always recorded, in the engine.
   */
  let askedByUser = false

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
    queryInput.classList.remove('invalid', 'denied')
    queryError.hidden = true
    renderExplain(explainHost, null)
    app.set({ query: { text: '', submitted: false } })
  }

  /** A human pressed Enter or clicked an example. */
  function runQuery(): void {
    const sql = queryInput.value.trim()
    if (sql.length === 0) {
      clearQuery()
      return
    }
    askedByUser = true
    // Submitting is a state change; render() is what actually runs it, so the
    // asked-once path and the scrubbed-many-times path cannot drift apart. A
    // fresh object literal every time means re-pressing Enter on unchanged text
    // still notifies — asking the same question twice is a real thing to do.
    app.set({ query: { text: sql, submitted: true } })
  }

  /**
   * Runs the current query at the scrubber's two axes.
   *
   * The axes are passed as values, not appended to the SQL as an `as of` clause:
   * that clause takes a wall clock, and the system axis is a transaction INDEX.
   * Several transactions routinely share one second — every live feed lands in
   * the same minute bucket — so a round-trip through the clock would resolve to
   * the last of them rather than the one the scrubber is on.
   */
  function executeQuery(sql: string): void {
    const record = askedByUser
    askedByUser = false

    // A query that names its own instant keeps it. Everything else is pinned to
    // the scrubber, which is where the two axes live for every other panel.
    const result = hasAsOf(sql)
      ? engine.runQuery(sql)
      : engine.runQueryAt(sql, app.state.validAt, app.state.sysAt, record)

    // A policy refusal is NOT a syntax error. Conflating them would tell the
    // user to fix their typing when there is nothing wrong with it — the
    // query was understood perfectly and declined.
    if (result.denied) {
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
      clearLayers(result.buffer)
      renderExplain(explainHost, null)
      return
    }

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
    updateLayerCounts(dockEl, globe.layerCounts)

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

  refreshAudit()

  const benchHost = document.querySelector<HTMLElement>('#bench')!
  document.querySelector<HTMLButtonElement>('#bench-run')!.addEventListener('click', () => {
    runBenchmark(engine, benchHost)
  })

  Object.assign(window, {
    __parallax: {
      engine,
      globe,
      scrubber,
      app,
      render,
      runQuery,
      refreshAudit,
      // Exposed so the duplicate guard can be exercised from a console: run one
      // cycle twice over the same spec and the second must commit nothing.
      ingestor,
      scheduler,
      specs: SOURCE_SPECS,
      attrs,
      feeds: () => feeds,
    },
  })
}

// A boot failure must land on screen, not only in a console nobody has open —
// the status line already says FAILED, and this is what says why.
void main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : 'Boot failed after the engine started.', err)
})
