// ── web/src/sources/spec.ts ─────────────────────────────────────────────────
// What a data source has to declare to become a layer on the globe.
//
// Before this existed, adding a source meant editing main.ts in four places: an
// entry in the allSettled tuple, a branch to build its batches, a min/max loop
// over its timestamps, and a hardcoded arm in the refresh function. Three
// sources fit in that shape. Fifteen do not, and the fourth edit is the one
// everybody forgets.
//
// ── layers and sources are not the same thing ──────────────────────────────
//
// USGS and EMSC are two sources that feed ONE layer, deliberately: they both
// describe earthquakes, they share the `position` attribute, and that shared
// attribute is what creates the entity-resolution problem this engine exists to
// show. So visuals and query bindings belong to the LAYER, and a source only
// says which layer it feeds.
// ────────────────────────────────────────────────────────────────────────────
import type { LayerSpec } from '../render/map'
import type { Batch, EntityRegistry } from './batch'

/** Mirrors px::Sensitivity in engine/include/px/policy.hpp. */
export const Sensitivity = {
  Public: 0,
  Precise: 1,
  PersonLinked: 2,
} as const
export type Sensitivity = (typeof Sensitivity)[keyof typeof Sensitivity]

/** Groups the layer panel. Ordered as the panel renders them. */
export const CATEGORIES = [
  'hazards',
  'maritime',
  'aviation',
  'space',
  'threats',
  'network',
] as const
export type Category = (typeof CATEGORIES)[number]

/**
 * One attribute a source writes, and how sensitive it is.
 *
 * This is the input to `PolicyTable::set_sensitivity`. It is declared per source
 * rather than set centrally because the source is the only thing that knows what
 * it is actually publishing — and because policy.hpp defaults unregistered
 * attributes to `Public`, which is fail-open. That default was defensible when
 * two attributes existed and a human could hold both in their head. It stops
 * being defensible at fifteen layers, so registration is made mechanical here
 * instead: an attribute cannot reach the store without passing through this
 * declaration.
 */
export interface AttrDecl {
  name: string
  sensitivity: Sensitivity
}

/** Resolved attribute ids, keyed by the names an AttrDecl declared. */
export type AttrIds = Readonly<Record<string, number>>

export interface NormalizeContext {
  attrs: AttrIds
  registry: EntityRegistry
  /**
   * Interns a string and returns its SymbolId, for `Kind::Sym` values.
   *
   * Memoised inside Engine, so a place name repeated across a thousand quakes
   * costs one map lookup after the first. The id is only meaningful against the
   * engine's own SymbolTable — which is the point: the engine resolves it back
   * to text when it renders provenance, so no symbol table crosses the boundary.
   */
  intern: (text: string) => number
}

/**
 * One thing the query builder can filter a layer on.
 *
 * Declared per layer rather than hardcoded in the builder because the planner
 * resolves `where` field names against the store's global symbol table, and an
 * unresolvable field does not error — it silently matches nothing. A builder
 * generated from these declarations can only offer fields that exist, which
 * turns a whole class of empty result into a class that cannot be expressed.
 *
 * `attr` is any attribute a source feeding this layer declares, not only
 * `scalarAttr`: depth, region and alert_level are all just as filterable.
 */
export interface FilterField {
  /** The interned attribute name, exactly as the source declares it. */
  attr: string
  /** What a person calls it. */
  label: string
  kind: 'number' | 'enum' | 'text'
  unit?: string
  /** Slider bounds. Falls back to the visual ramp when omitted. */
  min?: number
  max?: number
  step?: number
  /** For `enum`: the exact interned symbols, with readable names. */
  options?: readonly { value: string; label: string }[]
  /** Offered comparisons. Defaults to the numeric set. */
  ops?: readonly CmpOp[]
}

/** Mirrors `cmp_op` in px/ql/parser.hpp. */
export type CmpOp = '=' | '!=' | '>' | '>=' | '<' | '<=' | '~'

/**
 * A render layer: what it looks like, and what `earthquakes` means to the planner.
 *
 * `geoAttr`/`scalarAttr` are attribute NAMES here, resolved to ids at boot. The
 * ids are assigned by intern order and are not stable across builds; the names
 * are.
 */
export interface LayerDef {
  name: string
  label: string
  category: Category
  geoAttr: string
  scalarAttr: string
  /** Query-language aliases bound to this layer's attributes. */
  qlNames: readonly string[]
  visual: LayerSpec
  enabledByDefault?: boolean

  /**
   * What the query builder offers for this layer.
   *
   * Omitted means the builder falls back to the scalar attribute alone, which is
   * always filterable — so a new layer is usable from the builder the moment it
   * is registered, and declaring this only makes it better.
   */
  filters?: readonly FilterField[]

  /** Unit for `scalarAttr`, shown in the legend and the builder. */
  scalarUnit?: string

  /**
   * A worked example for the spatial control: somewhere this layer actually has
   * data. A radius search centred on empty ocean returns nothing and teaches the
   * viewer that the feature is broken rather than that the box was empty.
   */
  spatialHint?: {
    defaultRadiusKm: number
    examplePoint?: readonly [number, number]
    exampleLabel?: string
  }
  /**
   * Run entity resolution over this layer's geo and scalar attributes.
   *
   * Opt-in per layer rather than global, because ER is only meaningful where two
   * or more sources describe the same real-world object under different ids. A
   * layer with a single feed has no duplicates to find, and running the blocker
   * over it would burn time to merge nothing.
   */
  resolveEntities?: boolean
}

/**
 * One feed.
 *
 * `fetch` and `normalize` are split so that a failed fetch degrades to a dead
 * row in the layer panel rather than an exception in the middle of ingest —
 * the same reason main.ts used allSettled from the start.
 */
/**
 * What the map is currently looking at.
 *
 * Passed to sources that cannot sensibly fetch the whole world — global ADS-B
 * for civil traffic is tens of thousands of aircraft and a volunteer-funded
 * endpoint, so it is asked about the region on screen instead.
 */
export interface Viewport {
  minLat: number
  minLon: number
  maxLat: number
  maxLon: number
  centerLat: number
  centerLon: number
  radiusKm: number
  zoom: number
}

export interface SourceSpec<Raw = unknown> {
  /**
   * Stable id, matching the entry in SOURCES. Written into every fact, so it is
   * persisted in snapshots — NEVER renumber one.
   */
  id: number
  /** Key into SOURCES for licence and attribution. */
  key: string
  label: string
  /** The LayerDef this source feeds. Several sources may feed one layer. */
  layer: string
  attributes: readonly AttrDecl[]
  /** Shown in the layer panel where coverage is not what a viewer would assume. */
  coverageNote?: string
  fetch(signal?: AbortSignal, view?: Viewport): Promise<Raw>
  /** Records → facts. Must not ingest; the scheduler owns transaction order. */
  normalize(raw: Raw, ctx: NormalizeContext): { batches: Batch[]; count: number }

  /**
   * Seconds between refetches. Absent means fetched once, at boot.
   *
   * Opting in per source rather than polling everything on a global timer,
   * because the right interval is a property of the feed: ADS-B positions are
   * stale in twenty seconds and a week of earthquakes is not.
   */
  pollSeconds?: number

  /**
   * This source has no revision timestamp, so its system time is the moment
   * THIS CLIENT fetched it.
   *
   * Every other source carries its own: USGS has `updated`, EMSC `lastupdate`,
   * GDACS `datemodified`, AIS `timestampExternal`, ADS-B `seen_pos`, SWPC an
   * observation time. EONET has nothing of the kind.
   *
   * It matters for the duplicate guard. A fact's identity normally includes the
   * system time, because that is what distinguishes a revision from a repeat.
   * When the client invents that timestamp, every refetch looks like a revision —
   * so re-fetching an unchanged EONET returned 1500 "new" facts a poll, which is
   * precisely the manufactured system-time history the guard exists to prevent.
   * For these sources identity is (source, entity, attribute, validity) alone.
   *
   * The cost is stated rather than hidden: a change this source makes WITHOUT
   * changing an event's validity window is invisible to us. That is a real gap,
   * and it is smaller than the alternative, which is a system axis that advances
   * every time the page polls.
   */
  systemTimeIsFetchTime?: boolean

  /**
   * Fetch is scoped to what is on screen. Never fetched before a viewport exists.
   *
   * `preferred` means the source can answer globally but does better with a
   * region; `required` means a global fetch is not an option worth offering.
   */
  viewport?: 'required' | 'preferred'

  /**
   * Files under `public/` this source needs, relative to BASE_URL.
   *
   * Declared rather than fetched ad hoc so a missing asset surfaces as a named
   * feed error in the layer panel instead of a 404 in a console nobody has open.
   */
  assets?: readonly string[]

  /**
   * Set when this source's facts are COMPUTED rather than observed.
   *
   * Orbital positions are propagated from an element set, not measured. That is
   * a real epistemic difference and the interface says so rather than letting a
   * prediction sit on the map looking like an observation. Sources carrying this
   * are expected to assert facts ABOVE the scrubber's diagonal — valid time
   * later than the system time that produced them — which is how a viewer sees
   * it without reading anything.
   */
  derivation?: { method: string; note: string }

  /**
   * Seconds between re-deriving from the LAST fetched payload, without refetching.
   *
   * Only meaningful with `derivation`: recomputing an observation would invent
   * data. A TLE is refetched every few hours and re-propagated every few seconds.
   */
  recomputeSeconds?: number
}

/** Per-source outcome for one ingest cycle. Reported, never silently dropped. */
export interface FeedStatus {
  key: string
  label: string
  layer: string
  category: Category
  count: number
  coverageNote?: string
  error?: string
}
