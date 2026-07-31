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
  fetch(signal?: AbortSignal): Promise<Raw>
  /** Records → facts. Must not ingest; the scheduler owns transaction order. */
  normalize(raw: Raw, ctx: NormalizeContext): { batches: Batch[]; count: number }
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
