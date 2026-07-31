// ── web/src/render/map.ts ───────────────────────────────────────────────────
// The globe. MapLibre owns the camera, the basemap and the frame loop; the
// engine's data is drawn into that frame by pointsLayer.ts.
//
// Replaces the hand-built three.js sphere. That renderer drew a near-black ball
// with a graticule and dots on it, and a comment promising Natural Earth
// coastlines "in Phase 4" that never arrived. What was actually being traded
// away for a boundary property MapLibre never threatened was coastlines, camera
// controls, zoom, imagery and picking. See docs/decisions/0005.
//
// ── basemap licensing ──────────────────────────────────────────────────────
//
// Both basemaps are keyless and carry licences this project can accept without
// contradicting itself:
//
//   MAP  OpenFreeMap (OpenStreetMap data, ODbL) — no key, no rate limit
//   SAT  NASA GIBS (US Government work, public domain)
//
// The obvious satellite choice, EOX Sentinel-2 cloudless, is CC BY-NC-SA for
// every year from 2018 on — the same licence this project refuses TeleGeography
// submarine cables over. Share-alike on a basemap is worse than on a data layer
// because it sits under every screenshot and every exported result, so its
// obligations attach to everything. GIBS also happens to be the better choice on
// the merits: it is daily imagery, so cloud, smoke and dust are visible, where a
// static mosaic is wallpaper.
// ────────────────────────────────────────────────────────────────────────────
import { Map as MlMap, NavigationControl, ScaleControl, setWorkerUrl } from 'maplibre-gl'
import type { StyleSpecification } from 'maplibre-gl'
// `?worker&url` — BUNDLES the worker with its dependencies and returns the URL.
// Plain `?url` copies the file verbatim, which breaks it: the worker imports a
// sibling `maplibre-gl-shared.mjs` that is then not next to it, so the module
// fails to load and the worker closes the instant it starts. See setWorkerUrl.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

import type { Viewport } from '../sources/spec'
import type { LayerSpec } from './pointsLayer'
import { PointProgramCache, PointsLayer } from './pointsLayer'

export type { LayerSpec } from './pointsLayer'

/**
 * Tell MapLibre where its worker actually is.
 *
 * v6 locates the worker by taking `import.meta.url` AT RUNTIME and swapping the
 * filename for `maplibre-gl-worker.mjs`. That is invisible to a bundler, so Vite
 * never emits the chunk, and the request resolves to a path that does not exist
 * — which on a SPA host returns index.html with `Content-Type: text/html`, HTTP
 * 200. The worker then fails to execute.
 *
 * Nothing reports this. The map still constructs, the style still parses, layers
 * still attach, `render` still fires. But EVERY source is parsed in that worker,
 * so vector tiles never arrive and neither does any GeoJSON: the result is a
 * globe with no coastline, no borders and no place names — a dark ball — with an
 * empty console and a healthy frame counter.
 *
 * Importing the worker with `?url` makes Vite emit it and return the hashed
 * path, which is then handed over explicitly. Module scope, so it is set before
 * any Map is constructed.
 */
setWorkerUrl(maplibreWorkerUrl)

export type Basemap = 'dark' | 'sat' | 'live'
export type ProjectionMode = 'globe' | 'mercator'

// `dark` rather than `liberty`: its background is rgb(12,12,12), within a shade
// of the 0x0e0e11 sphere the three.js renderer drew. The HUD, the scrubber and
// the colour ramps were all designed against that value, and a daylight basemap
// makes the amber-to-red seismic ramp illegible.
const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/dark'

const RASTER: Record<Exclude<Basemap, 'dark'>, { layer: string; source: string }> = {
  sat: { layer: 'px-sat', source: 'px-s2' },
  live: { layer: 'px-live', source: 'px-gibs' },
}

/** Frames skipped before frame-time averaging begins. Carried over unchanged. */
const WARMUP_FRAMES = 5

/**
 * GIBS publishes each day's imagery some hours after acquisition, so "today"
 * is frequently a wall of blank tiles. Two days back is always populated.
 */
function recentImageryDate(): string {
  const d = new Date(Date.now() - 2 * 86_400_000)
  return d.toISOString().slice(0, 10)
}

/**
 * Coastlines and administrative boundaries, drawn from data we ship.
 *
 * The dark style carries its own — `boundary_state` and two `boundary_country`
 * layers — but they come from the `openmaptiles` VECTOR SOURCE, and that source
 * requests no tiles at all here: the TileJSON resolves, the worker spawns, one
 * covering tile is computed, and not a single .pbf is ever fetched. Reproduced
 * under both software and Metal GPU, and with the UNMODIFIED upstream style, so
 * it is neither our style edits nor the renderer. Whatever the cause, the result
 * is a globe with no coastline and no borders — a dark ball you cannot navigate.
 *
 * Natural Earth is the answer that does not depend on that pipeline. It is
 * public domain, it is the reference dataset for exactly this, and 144 KB
 * gzipped buys a legible planet that cannot silently fail to arrive. The style's
 * own boundary layers are hidden so the two can never double-draw.
 *
 * Neutral grey deliberately. Every saturated colour on this map means something
 * — amber seismic, teal maritime, green aurora — so a coloured border would
 * read as another data layer rather than as the basemap.
 */
const NE: { id: string; file: string; color: string; opacity: number; width: [number, number] }[] = [
  // Coastline first and dimmest: it is the most line by far, and it is context
  // rather than information.
  { id: 'px-ne-coast', file: 'coastline.json', color: 'hsl(205, 18%, 46%)', opacity: 0.85, width: [0.6, 1.6] },
  // States: subordinate to countries, and dashed below.
  { id: 'px-ne-states', file: 'states.json', color: 'hsl(210, 10%, 44%)', opacity: 0.7, width: [0.4, 1.1] },
  // Countries: the strongest line on the basemap.
  { id: 'px-ne-countries', file: 'countries.json', color: 'hsl(210, 16%, 66%)', opacity: 0.9, width: [0.8, 2.2] },
]

/** The style's own vector boundaries, hidden in favour of the shipped ones. */
const BOUNDARY_PAINT: Record<string, { color: string; opacity: number; boost: number }> = {
  // Countries: the strongest line on the basemap.
  'boundary_country_z0-4': { color: 'hsl(210, 14%, 62%)', opacity: 0.75, boost: 1.0 },
  'boundary_country_z5-': { color: 'hsl(210, 14%, 62%)', opacity: 0.75, boost: 1.0 },
  // States and provinces: clearly subordinate, and dashed already, so the two
  // are distinguishable at a glance rather than only by weight.
  boundary_state: { color: 'hsl(210, 10%, 48%)', opacity: 0.5, boost: 0.8 },
}

/** Imagery is bright and busy; borders need more contrast over it than over dark. */
const BOUNDARY_OPACITY_OVER_IMAGERY = 1.0


/**
 * Land and water, made distinguishable.
 *
 * The `dark` style has NO land fill — land is literally the page background,
 * rgb(12,12,12) — and water is rgb(27,27,29). Fifteen units of lightness apart,
 * which at world zoom is a black rectangle. It is a city style: it assumes you
 * are close enough that roads and buildings carry the structure, and at z1 there
 * are no roads.
 *
 * Land is lifted and water is pushed down so the coastline is legible before any
 * data is drawn on it. Both stay far below the dimmest data colour — a basemap
 * that competes with the points is worse than one you cannot see.
 */
const LAND_COLOR = '#181c22'
const WATER_COLOR = '#05080d'

/** Screen-space hit tolerance. Roughly a fingertip, and wider than most dots. */
const PICK_TOLERANCE_PX = 12

/** Where the user pointed, in both the world's units and the screen's. */
export interface PickEvent {
  lat: number
  lon: number
  /** Great-circle radius equivalent to PICK_TOLERANCE_PX at this zoom. */
  radiusM: number
  screen: { x: number; y: number }
}

/**
 * Great-circle distance in metres, mirroring px::haversine_m so the client and
 * the engine agree on what "within 12 pixels" means.
 */
function haversineMetres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_008.8
  const toRad = Math.PI / 180
  const dLat = (lat2 - lat1) * toRad
  const dLon = (lon2 - lon1) * toRad
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

/**
 * Whether the stylesheet is parsed and `addLayer` will therefore work.
 *
 * Deliberately NOT `map.isStyleLoaded()`, which additionally requires every
 * source to have loaded. A single dead tile source would make that false
 * forever, and gating layer attachment on it would turn one bad source into a
 * map with no data on it at all — the exact failure this check exists to
 * prevent.
 */
function styleIsParsed(map: MlMap): boolean {
  // getStyle() serialises the stylesheet and can throw before one exists, which
  // would propagate out of an event handler and take the frame with it.
  try {
    return (map.getStyle()?.layers?.length ?? 0) > 0
  } catch {
    return false
  }
}

export interface GlobeOptions {
  container: HTMLElement
  maxPoints: number
}

/**
 * Fetches the basemap style and returns it with the projection and the satellite
 * source already in it.
 *
 * Everything here could be done imperatively after `style.load`, and was at
 * first. Handing MapLibre one complete style instead means there is no window
 * during which the style is half-initialised, and no post-load mutation to race
 * with — `setProjection` in particular reinitialises projection state that
 * sources have already been set up against.
 *
 * Honesty about why this changed: it was written to fix a blank basemap, and it
 * did not fix it. The actual cause was the verification browser running as a
 * hidden tab, where requestAnimationFrame never fires and MapLibre's entire
 * render loop — and therefore its tile loading — is stalled. This form is kept
 * because it is the better construction, not because it repaired anything.
 */
async function buildStyle(): Promise<StyleSpecification> {
  const res = await fetch(BASEMAP_STYLE)
  if (!res.ok) throw new Error(`basemap style ${res.status} from ${BASEMAP_STYLE}`)
  const style = (await res.json()) as StyleSpecification

  style.projection = { type: 'globe' }

  // Sentinel-2 cloudless: 10 m native, usable to z15, so SAT is genuinely a map
  // of the ground rather than a 250 m smear.
  style.sources[RASTER.sat.source] = {
    type: 'raster',
    tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg'],
    tileSize: 256,
    maxzoom: 15,
    attribution:
      '<a href="https://s2maps.eu">Sentinel-2 cloudless 2024</a> by EOX IT Services GmbH ' +
      '(contains modified Copernicus Sentinel data 2024)',
  }

  // GIBS is TODAY's imagery. Coarse at 250 m, but it shows cloud, smoke plumes
  // and dust that a static mosaic cannot, which is what an operational picture
  // actually wants.
  style.sources[RASTER.live.source] = {
    type: 'raster',
    tiles: [
      'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/' +
        `VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${recentImageryDate()}/` +
        'GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg',
    ],
    tileSize: 256,
    // Level9 tops out at z8; MapLibre overzooms past it rather than 404ing.
    maxzoom: 8,
    attribution:
      'Imagery <a href="https://worldview.earthdata.nasa.gov/">NASA EOSDIS GIBS</a> (public domain)',
  }

  // Imagery slots in ABOVE the landcover fills but BELOW roads and labels, so
  // satellite mode is a true hybrid: the ground, with the street network and
  // place names still drawn on top. Inserting above the line layers instead
  // would give imagery with no roads, which is what makes most satellite views
  // useless for orientation.
  const firstOverlay = style.layers.findIndex((l) => l.type === 'line' || l.type === 'symbol')
  const at = firstOverlay === -1 ? style.layers.length : firstOverlay

  for (const mode of ['live', 'sat'] as const) {
    style.layers.splice(at, 0, {
      id: RASTER[mode].layer,
      type: 'raster',
      source: RASTER[mode].source,
      layout: { visibility: 'none' },
      paint: { 'raster-opacity': 1 },
    })
  }

  // Land/water contrast, before boundaries. Without this the globe is a black
  // disc at every zoom below about z8.
  for (const layer of style.layers) {
    if (layer.type === 'background') {
      layer.paint = { ...(layer.paint ?? {}), 'background-color': LAND_COLOR } as never
    } else if (layer.id === 'water' && layer.type === 'fill') {
      layer.paint = { ...(layer.paint ?? {}), 'fill-color': WATER_COLOR } as never
    }
  }

  // The style's own boundaries are hidden rather than restyled: their source
  // never delivers, and leaving them visible would double-draw if it ever did.
  for (const layer of style.layers) {
    if (!(layer.id in BOUNDARY_PAINT)) continue
    layer.layout = { ...(layer.layout ?? {}), visibility: 'none' } as never
  }

  // Coastline and borders from data we ship. Inserted after the imagery so they
  // draw over it, and before the first symbol layer so place names stay on top.
  const labelsAt = style.layers.findIndex((l) => l.type === 'symbol')
  const insertAt = labelsAt === -1 ? style.layers.length : labelsAt

  for (let i = 0; i < NE.length; i++) {
    const ne = NE[i]!
    style.sources[ne.id] = { type: 'geojson', data: `${import.meta.env.BASE_URL}ne/${ne.file}` }
    style.layers.splice(insertAt + i, 0, {
      id: ne.id,
      type: 'line',
      source: ne.id,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': ne.color,
        'line-opacity': ne.opacity,
        // Thin at world zoom, heavier as you close in.
        //
        // ['zoom'] must be the DIRECT input of a top-level interpolate. Nesting
        // it inside any other expression — even something as innocent as
        // ['*', <interpolate>, 0.8] — makes MapLibre reject the entire style,
        // not just this property. That leaves no basemap and nowhere to attach a
        // custom layer, while `render` keeps firing, so the frame counter reads
        // healthy over a black canvas with nothing logged. It cost a full
        // debugging round; scale the stop outputs instead.
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, ne.width[0], 10, ne.width[1]],
        ...(ne.id === 'px-ne-states' ? { 'line-dasharray': [3, 2] } : {}),
      },
    } as never)
  }

  return style
}

export class Globe {
  /** Null until the style has been fetched. Every caller-facing method tolerates that. */
  #map: MlMap | null = null

  #layers = new Map<string, PointsLayer>()
  #programs = new PointProgramCache()
  #maxPoints: number

  #ready = false
  #firstSymbolId: string | undefined
  #basemap: Basemap = 'dark'

  #frameEma = 0
  #frames = 0
  #lastFrameAt = 0

  #autoRotate = true
  #rotating = false

  #disposed = false

  /** Set if layer attachment threw. Surfaced through renderFault. */
  #attachFault: string | null = null

  constructor(opts: GlobeOptions) {
    this.#maxPoints = opts.maxPoints
    void this.#init(opts)
  }

  /** The underlying MapLibre map, once the style has loaded. */
  get map(): MlMap | null {
    return this.#map
  }

  async #init(opts: GlobeOptions): Promise<void> {
    let style: StyleSpecification
    try {
      style = await buildStyle()
    } catch (err) {
      // A dead basemap must not take the engine down with it — the same
      // allSettled reasoning the feeds use. The data layers still render; they
      // just render over nothing.
      console.error('[parallax] basemap style failed to load', err)
      return
    }
    if (this.#disposed) return

    const map = new MlMap({
      container: opts.container,
      style,
      center: [20, 25],
      zoom: 1.4,
      // Attribution is not optional for either basemap. MapLibre renders the
      // control from each source's `attribution` field; sources/registry.ts
      // carries the same obligations for the data layers.
      attributionControl: { compact: true },
      maxPitch: 85,
    })
    this.#map = map

    map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right')
    map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left')

    // `style.load`, NOT `load`. They are not interchangeable: `load` also waits
    // for the first full tile set, so on a slow network — or a throttled
    // background tab — it can be many seconds late or never fire at all, and the
    // data layers never get added to a map that is visibly working.
    //
    // Three ways in, because a single `once('style.load')` is a RACE. This map is
    // constructed from a style OBJECT, not a URL, so MapLibre has no network to
    // wait for and can finish loading before this line runs — the listener then
    // waits forever for an event that already fired, and the symptom is a black
    // canvas whose frame counter looks perfectly healthy, because `render` fires
    // whether or not a style is loaded.
    //
    // `isStyleLoaded()` alone cannot detect that: it also requires every source
    // to be loaded, so it reads false immediately after construction even when
    // the style itself is ready. Hence `styledata` as well, which fires
    // repeatedly and catches the case the other two miss.
    // Attachment now runs inside the render handler, so it must not be able to
    // throw: MapLibre can still reject addLayer after the stylesheet parses, and
    // an exception escaping a render listener kills the frame — which is the
    // precise failure this whole change exists to eliminate. Record and stop
    // retrying instead.
    const attach = (): void => {
      try {
        this.#onStyleLoaded()
      } catch (err) {
        this.#attachFault = err instanceof Error ? err.message : String(err)
        this.#ready = true // stop retrying; renderFault now reports the reason
        console.error('[parallax] could not attach data layers', err)
      }
    }
    if (styleIsParsed(map)) attach()
    else {
      map.once('style.load', attach)
      map.on('styledata', attach)
    }

    // Every layer needs the zoom to decide between a dot and a glyph, and
    // `zoom` fires for the whole of a pinch as well as for a wheel notch. Pushed
    // here rather than read inside render(), so the layers stay ignorant of the
    // map object.
    const pushZoom = (): void => {
      const z = map.getZoom()
      for (const layer of this.#layers.values()) layer.setZoom(z)
    }
    map.on('zoom', pushZoom)
    map.on('move', pushZoom)
    pushZoom()

    map.on('render', () => {
      // The guarantee. `render` fires for as long as the map exists and cannot
      // be missed the way a one-shot event can, so attachment is retried here
      // until it succeeds. The two listeners above only make it happen sooner.
      //
      // `styleIsParsed` serialises the stylesheet, which is far too expensive to
      // do every frame — hence the `#ready` guard, which makes this free the
      // moment the layers are on and forever after.
      if (!this.#ready) attach()
      this.#tick()
    })
    this.#bindPicking(map)

    // Registered before the style finished loading, so it is bound here rather
    // than dropped on the floor.
    this.#pendingViewportHandler?.(map)
    this.#pendingViewportHandler = null

    // Feed failures are surfaced in the layer panel; a basemap or tile failure
    // should not be the one thing that fails silently.
    map.on('error', (e) => console.error('[parallax] map', e.error ?? e))

    // Any deliberate camera input ends the idle spin. A globe that keeps
    // drifting while you are trying to read a harbour is hostile.
    for (const ev of ['mousedown', 'touchstart', 'wheel', 'dragstart'] as const) {
      map.on(ev, () => {
        this.#autoRotate = false
        this.#rotating = false
      })
    }
  }

  // ── style ────────────────────────────────────────────────────────────────

  /**
   * The projection and the satellite source are already in the style — see
   * buildStyle. All that is left is attaching the custom layers, which is the
   * one thing a style object cannot carry.
   */
  #onStyleLoaded(): void {
    const map = this.#map
    // Idempotent: three separate paths can reach this, and only the first that
    // finds a parsed stylesheet should do anything.
    if (!map || this.#ready || !styleIsParsed(map)) return

    this.#firstSymbolId = map.getStyle().layers?.find((l) => l.type === 'symbol')?.id
    this.#ready = true

    // Layers requested before the style finished loading are attached now, in
    // the order they were asked for.
    for (const layer of this.#layers.values()) this.#attach(layer)

    this.setBasemap(this.#basemap)
    if (this.#autoRotate) this.#spin()
  }

  #attach(layer: PointsLayer): void {
    const map = this.#map
    if (!map || map.getLayer(layer.id)) return
    map.addLayer(layer, this.#firstSymbolId)
  }

  // ── data layers ──────────────────────────────────────────────────────────

  /**
   * Creates a named data layer. Each owns one instanced draw call and one colour
   * ramp, so seismic and maritime stay visually distinct without either needing
   * a per-point source field in the wire format — which would break the 16-byte
   * stride the whole boundary design depends on.
   */
  addLayer(name: string, spec: LayerSpec): void {
    if (this.#layers.has(name)) return
    const layer = new PointsLayer(name, spec, this.#maxPoints, this.#programs)
    this.#layers.set(name, layer)
    if (this.#ready) this.#attach(layer)
  }

  /**
   * Points a layer at a fresh view over the wasm heap.
   *
   * `view` must be re-derived from Heap on every call and never cached — the
   * rule is unchanged from the three.js renderer. See PointsLayer.setData.
   */
  updateLayer(name: string, view: Float32Array, count: number): void {
    const layer = this.#layers.get(name)
    if (!layer) return
    layer.setData(view, count)
    this.#map?.triggerRepaint()
  }

  /**
   * Why the map might be showing nothing.
   *
   * `null` means healthy. Anything else is the one line worth putting on screen:
   * a black canvas with a ticking frame counter is indistinguishable from "the
   * feeds returned no data", and the two have completely different fixes.
   */
  get renderFault(): string | null {
    if (this.#attachFault) return `layer attach failed: ${this.#attachFault}`
    if (!this.#map) return 'basemap style did not load'
    if (!this.#ready) return 'style loaded but layers not attached'
    for (const [name, layer] of this.#layers) {
      if (layer.failure) return `layer ${name}: ${layer.failure}`
      if (!this.map?.getLayer(name)) return `layer ${name} not attached to the map`
    }
    return null
  }

  /** Instances currently drawn per layer. Diagnostics, and how tests see routing. */
  get layerCounts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [name, layer] of this.#layers) out[name] = layer.count
    return out
  }

  setLayerVisible(name: string, visible: boolean): void {
    const layer = this.#layers.get(name)
    if (!layer) return
    layer.visible = visible
    this.#map?.triggerRepaint()
  }

  // ── view controls ────────────────────────────────────────────────────────

  /**
   * Switches imagery WITHOUT `setStyle`.
   *
   * setStyle would destroy every custom layer, taking their GPU buffers with it
   * and leaving the data empty until the next refresh re-uploaded it. Both
   * rasters are in the style from the start, so this is a visibility flip that
   * cannot race and costs nothing.
   */
  setBasemap(which: Basemap): void {
    this.#basemap = which
    const map = this.#map
    if (!map || !this.#ready) return
    for (const mode of ['sat', 'live'] as const) {
      if (!map.getLayer(RASTER[mode].layer)) continue
      map.setLayoutProperty(RASTER[mode].layer, 'visibility', which === mode ? 'visible' : 'none')
    }

    // Borders carry the whole orientation burden once imagery is underneath, so
    // they are lifted rather than left at their dark-basemap weight.
    for (const ne of NE) {
      if (!map.getLayer(ne.id)) continue
      map.setPaintProperty(
        ne.id,
        'line-opacity',
        which === 'dark' ? ne.opacity : BOUNDARY_OPACITY_OVER_IMAGERY,
      )
    }
  }

  get basemap(): Basemap {
    return this.#basemap
  }

  setProjectionMode(mode: ProjectionMode): void {
    this.#map?.setProjection({ type: mode })
  }

  get projectionMode(): ProjectionMode {
    // MapLibre reports the resolved projection; during a transition it reports
    // the target, which is what a toggle wants to reflect.
    return this.#map?.getProjection()?.type === 'mercator' ? 'mercator' : 'globe'
  }

  // ── picking ──────────────────────────────────────────────────────────────

  /**
   * Reports hover and click positions, with a radius in metres.
   *
   * The radius is derived by unprojecting the cursor and a point twelve pixels
   * to its right and measuring the ground distance between them, so tolerance
   * stays twelve screen pixels at every zoom and under both projections —
   * a fixed distance would be unusably coarse at z1 and unusably tight at z14.
   *
   * Hover is throttled to one animation frame. mousemove fires far faster than
   * that, and every extra call is a spatial query and a JSON build that nothing
   * will ever read.
   */
  /**
   * Fires once the camera has settled somewhere new.
   *
   * `moveend` rather than `move`: a pan emits hundreds of move events, and a
   * viewport-scoped source would issue a fetch for every intermediate frame of a
   * gesture whose destination is the only one anybody wanted.
   */
  onViewportSettled(handler: (view: Viewport) => void): void {
    const bind = (map: MlMap): void => {
      map.on('moveend', () => {
        const v = this.viewport()
        if (v) handler(v)
      })
    }
    if (this.#map) bind(this.#map)
    else this.#pendingViewportHandler = bind
  }

  #pendingViewportHandler: ((map: MlMap) => void) | null = null

  onPick(handler: (pick: PickEvent | null, kind: 'hover' | 'click') => void): void {
    this.#onPick = handler
  }

  #onPick: ((pick: PickEvent | null, kind: 'hover' | 'click') => void) | null = null
  #pickQueued = false

  #radiusMetres(map: MlMap, point: { x: number; y: number }): number {
    const a = map.unproject([point.x, point.y])
    const b = map.unproject([point.x + PICK_TOLERANCE_PX, point.y])
    return haversineMetres(a.lat, a.lng, b.lat, b.lng)
  }

  #bindPicking(map: MlMap): void {
    map.on('mousemove', (e) => {
      if (!this.#onPick || this.#pickQueued) return
      this.#pickQueued = true
      requestAnimationFrame(() => {
        this.#pickQueued = false
        if (!this.#onPick) return
        const ll = map.unproject(e.point)
        this.#onPick(
          { lat: ll.lat, lon: ll.lng, radiusM: this.#radiusMetres(map, e.point), screen: e.point },
          'hover',
        )
      })
    })

    // A cursor that leaves the canvas must clear the tooltip, or it hangs over
    // the HUD pointing at nothing.
    map.on('mouseout', () => this.#onPick?.(null, 'hover'))

    map.on('click', (e) => {
      if (!this.#onPick) return
      const ll = map.unproject(e.point)
      this.#onPick(
        { lat: ll.lat, lon: ll.lng, radiusM: this.#radiusMetres(map, e.point), screen: e.point },
        'click',
      )
    })
  }

  /** Sets the cursor, so a pickable point looks pickable. */
  setPickCursor(over: boolean): void {
    const canvas = this.#map?.getCanvas()
    if (canvas) canvas.style.cursor = over ? 'pointer' : ''
  }

  /** Flies the camera to a point, used by search results and alert firings. */
  flyTo(lat: number, lon: number, zoom = 6): void {
    this.#autoRotate = false
    this.#rotating = false
    this.#map?.flyTo({ center: [lon, lat], zoom, duration: 1200 })
  }

  // ── loop ─────────────────────────────────────────────────────────────────

  get frameMs(): number {
    return this.#frameEma
  }

  #tick(): void {
    const now = performance.now()
    if (this.#lastFrameAt > 0) {
      // Warmup frames are discarded: the first frames include shader
      // compilation and tile decode, and averaging them in makes the readout
      // claim a cost that is never paid again.
      if (this.#frames >= WARMUP_FRAMES) {
        const dt = now - this.#lastFrameAt
        this.#frameEma = this.#frameEma === 0 ? dt : this.#frameEma * 0.9 + dt * 0.1
      }
      this.#frames++
    }
    this.#lastFrameAt = now
  }

  /**
   * Idle rotation. MapLibre drives its own frame loop, so unlike the three.js
   * renderer there is no RAF to own here — `start`/`stop` gate the spin and
   * nothing else. Rendering already stops on its own when the map is idle.
   */
  start(): void {
    this.#autoRotate = true
    if (this.#ready) this.#spin()
  }

  stop(): void {
    this.#autoRotate = false
    this.#rotating = false
    // Clearing the flags does not cancel the easeTo already in flight, so the
    // globe kept turning after being told to stop — which silently invalidates
    // any screen coordinate computed from map.project() a moment earlier.
    this.#map?.stop()
  }

  set autoRotate(v: boolean) {
    if (v) this.start()
    else this.stop()
  }

  /**
   * Re-measures the container.
   *
   * MapLibre watches the container with a ResizeObserver, which does not fire
   * while the document is hidden — so a tab opened in the background boots with
   * the container at zero size and keeps the 400×300 default canvas after it is
   * finally looked at. Observed directly: `document.hidden` true at boot leaves a
   * 400×300 canvas inside a 1280×720 stage until something calls this.
   */
  resize(): void {
    this.#map?.resize()
  }

  /**
   * What is currently on screen, for sources that fetch by region.
   *
   * `radiusKm` is the great-circle distance from the centre to a corner, so a
   * radius query built from it covers the visible rectangle rather than the
   * circle inscribed in it — a source asked for the inscribed circle would leave
   * the corners of the viewport visibly empty.
   */
  viewport(): Viewport | null {
    const map = this.#map
    if (!map) return null
    const b = map.getBounds()
    const c = map.getCenter()
    const toRad = (d: number): number => (d * Math.PI) / 180
    const dLat = toRad(b.getNorth() - c.lat)
    const dLon = toRad(b.getEast() - c.lng) * Math.cos(toRad(c.lat))
    return {
      minLat: b.getSouth(),
      minLon: b.getWest(),
      maxLat: b.getNorth(),
      maxLon: b.getEast(),
      centerLat: c.lat,
      centerLon: c.lng,
      radiusKm: 6371 * Math.hypot(dLat, dLon),
      zoom: map.getZoom(),
    }
  }

  #spin(): void {
    if (this.#rotating || !this.#autoRotate) return
    this.#rotating = true

    const step = (): void => {
      if (!this.#autoRotate || !this.#rotating) {
        this.#rotating = false
        return
      }
      const map = this.#map
      if (!map) {
        this.#rotating = false
        return
      }
      const c = map.getCenter()
      map.easeTo({
        center: [c.lng + 6, c.lat],
        duration: 1000,
        easing: (t) => t, // linear, so chained eases do not visibly pulse
      })
      window.setTimeout(step, 1000)
    }
    step()
  }

  dispose(): void {
    this.#disposed = true
    this.#autoRotate = false
    this.#rotating = false
    this.#layers.clear()
    this.#map?.remove()
    this.#map = null
  }
}
