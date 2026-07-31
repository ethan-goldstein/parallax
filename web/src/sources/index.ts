// ── web/src/sources/index.ts ────────────────────────────────────────────────
// The layer and source registry. Adding a feed is one file plus one line here.
//
// A static array rather than `import.meta.glob`: source ids are written into
// every fact and must be reviewable in a diff, and eager globbing would defeat
// tsc's ability to check each spec's `Raw` type parameter against its own
// fetch/normalize pair.
// ────────────────────────────────────────────────────────────────────────────
import { airplanesSpec } from './airplanes'
import { digitrafficSpec } from './digitraffic'
import { emscSpec } from './emsc'
import { eonetSpec } from './eonet'
import { gdacsSpec } from './gdacs'
import type { LayerDef, SourceSpec } from './spec'
import { swpcSpec } from './swpc'
import { usgsSpec } from './usgs'

/**
 * Render layers, in panel order.
 *
 * Colour intent, carried over from main.ts: amber → red for seismic energy;
 * teal for maritime. Teal is the valid-time colour and vessel positions sit
 * exactly on the scrubber's diagonal (see digitraffic.ts) — the colour is
 * making that point, not decorating.
 *
 * sizeBase/sizeScale are SCREEN PIXELS. See LayerSpec in pointsLayer.ts for why
 * the unit changed with the renderer.
 */
export const LAYERS: readonly LayerDef[] = [
  {
    name: 'seismic',
    label: 'seismic',
    category: 'hazards',
    geoAttr: 'position',
    scalarAttr: 'magnitude',
    qlNames: ['earthquakes', 'quakes'],
    // USGS and EMSC independently locate the same quakes with different station
    // networks, magnitude scales and ids, and nothing joins them. That is the
    // real duplicate problem the resolver exists for.
    resolveEntities: true,
    visual: {
      colorLow: 0xffb000,
      colorHigh: 0xe5484d,
      sizeBase: 3.5,
      sizeScale: 2.6, // px per magnitude point
      rampLow: 2.5,
      rampHigh: 6.5,
    },
  },
  {
    name: 'maritime',
    label: 'maritime',
    category: 'maritime',
    geoAttr: 'vessel_position',
    scalarAttr: 'speed',
    qlNames: ['vessels', 'ships'],
    visual: {
      colorLow: 0x3fd0c9,
      colorHigh: 0xe8e6e1,
      sizeBase: 2.0,
      sizeScale: 0.2, // px per knot
      rampLow: 0,
      rampHigh: 20,
      // Vessels are assets, not energy. Additive blending would make a crowded
      // anchorage read as one bright smear instead of many ships.
      blend: 'normal',
    },
  },
  {
    name: 'alerts',
    label: 'disaster alerts',
    category: 'hazards',
    geoAttr: 'alert_position',
    scalarAttr: 'alert_level',
    qlNames: ['alerts', 'disasters'],
    visual: {
      // Green → red across GDACS's own three-step alert scale.
      colorLow: 0x4cc38a,
      colorHigh: 0xe5484d,
      sizeBase: 4.0,
      sizeScale: 3.0, // px per alert level
      rampLow: 0,
      rampHigh: 2,
    },
  },
  {
    name: 'events',
    label: 'natural events',
    category: 'hazards',
    geoAttr: 'event_position',
    scalarAttr: 'event_intensity',
    qlNames: ['events', 'wildfires'],
    visual: {
      // Flat ramp: the scalar is deliberately constant because EONET's
      // magnitudes are in incomparable units. See eonet.ts.
      colorLow: 0xff7a45,
      colorHigh: 0xff7a45,
      sizeBase: 2.6,
      sizeScale: 0,
      rampLow: 0,
      rampHigh: 1,
    },
  },
  {
    name: 'aviation',
    label: 'military air',
    category: 'aviation',
    geoAttr: 'aircraft_position',
    scalarAttr: 'altitude',
    qlNames: ['aircraft', 'flights'],
    visual: {
      colorLow: 0x8b8fa3,
      colorHigh: 0xe8e6e1,
      sizeBase: 2.2,
      sizeScale: 0.00006, // px per foot — ~2.4px at 40,000 ft
      rampLow: 0,
      rampHigh: 40_000,
      // Assets, not energy.
      blend: 'normal',
    },
  },
  {
    name: 'aurora',
    label: 'aurora forecast',
    category: 'space',
    geoAttr: 'aurora_position',
    scalarAttr: 'aurora_probability',
    qlNames: ['aurora'],
    visual: {
      // The one layer whose facts sit ABOVE the scrubber's diagonal. Green is
      // the aurora's own colour and reads as distinct from every hazard ramp.
      colorLow: 0x1f6f4a,
      colorHigh: 0x5ef2a8,
      sizeBase: 2.0,
      sizeScale: 0.05, // px per percentage point
      rampLow: 10,
      rampHigh: 70,
    },
  },
]

/**
 * Every registered feed. Order here is fetch order, not render order.
 *
 * Typed as `SourceSpec` (Raw = unknown). Each entry keeps its own concrete Raw
 * at its definition site, so tsc still checks that a source's fetch and its
 * normalize agree; erasure only happens where the scheduler iterates them.
 */
export const SOURCE_SPECS: readonly SourceSpec[] = [
  usgsSpec,
  emscSpec,
  digitrafficSpec,
  gdacsSpec,
  eonetSpec,
  airplanesSpec,
  swpcSpec,
]

export function layerByName(name: string): LayerDef | undefined {
  return LAYERS.find((l) => l.name === name)
}

/**
 * The layer a query targets, from the source name it opens with.
 *
 * The planner already resolves `vessels` to an attribute pair; this resolves the
 * same word to the layer whose visual identity should carry the result. Without
 * it a vessel query renders in the seismic ramp — amber dots for ships — because
 * the result buffer has no idea which source produced it.
 */
export function layerForQuery(sql: string): LayerDef | undefined {
  const first = sql.trim().split(/\s+/)[0]?.toLowerCase()
  if (!first) return undefined
  return LAYERS.find((l) => l.qlNames.includes(first))
}
