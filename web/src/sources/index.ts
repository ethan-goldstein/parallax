// ── web/src/sources/index.ts ────────────────────────────────────────────────
// The layer and source registry. Adding a feed is one file plus one line here.
//
// A static array rather than `import.meta.glob`: source ids are written into
// every fact and must be reviewable in a diff, and eager globbing would defeat
// tsc's ability to check each spec's `Raw` type parameter against its own
// fetch/normalize pair.
// ────────────────────────────────────────────────────────────────────────────
import { airplanesSpec, civilAircraftSpec } from './airplanes'
import { digitrafficSpec } from './digitraffic'
import { emscSpec } from './emsc'
import { eonetSpec } from './eonet'
import { gdacsSpec } from './gdacs'
import { nwsSpec } from './nws'
import { satellitesSpec } from './satellites'
import { chokepointsSpec, portsSpec } from './ports'
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
    scalarUnit: 'M',
    filters: [
      { attr: 'magnitude', label: 'magnitude', kind: 'number', unit: 'M',
        min: 0, max: 9, step: 0.1 },
      { attr: 'depth', label: 'depth', kind: 'number', unit: 'km',
        min: 0, max: 700, step: 5 },
      { attr: 'label', label: 'place', kind: 'text', ops: ['~', '='] },
    ],
    // Off the coast of Honshu: the most reliably populated seismic region on
    // Earth, so the example returns rows rather than teaching that the control
    // is broken.
    spatialHint: { defaultRadiusKm: 500, examplePoint: [38.3, 142.4], exampleLabel: 'Japan Trench' },
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
    scalarUnit: 'kn',
    filters: [
      { attr: 'speed', label: 'speed', kind: 'number', unit: 'kn',
        min: 0, max: 40, step: 0.5 },
    ],
    // The feed is Baltic-only, so the hint has to be Baltic too.
    spatialHint: { defaultRadiusKm: 40, examplePoint: [60.15, 24.95], exampleLabel: 'Helsinki' },
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
    name: 'ports',
    label: 'ports & terminals',
    category: 'maritime',
    geoAttr: 'port_position',
    scalarAttr: 'port_class',
    qlNames: ['ports', 'terminals'],
    scalarUnit: 'class',
    filters: [
      { attr: 'port_class', label: 'kind', kind: 'enum',
        options: [
          { value: '0', label: 'container' },
          { value: '1', label: 'energy' },
          { value: '2', label: 'naval' },
        ],
        ops: ['=', '!='] },
      { attr: 'port_label', label: 'name / country', kind: 'text', ops: ['~', '='] },
    ],
    spatialHint: { defaultRadiusKm: 800, examplePoint: [1.26, 103.82], exampleLabel: 'Singapore' },
    visual: {
      // Deep teal → pale, inside the maritime family so the category reads as one
      // domain, but distinctly cooler than the vessel ramp so a fixed berth is
      // never mistaken for a ship under way.
      colorLow: 0x2a7f8a,
      colorHigh: 0xbfe6e2,
      sizeBase: 3.0,
      sizeScale: 0.8,
      rampLow: 0,
      rampHigh: 2,
      blend: 'normal',
    },
  },
  {
    name: 'chokepoints',
    label: 'chokepoints',
    category: 'maritime',
    geoAttr: 'chokepoint_position',
    scalarAttr: 'chokepoint_label',
    qlNames: ['chokepoints', 'straits'],
    filters: [{ attr: 'chokepoint_label', label: 'name', kind: 'text', ops: ['~', '='] }],
    spatialHint: { defaultRadiusKm: 1500, examplePoint: [26.57, 56.25], exampleLabel: 'Hormuz' },
    visual: {
      // Flat, for the same reason natural events are: there is no measurement
      // here to rank these by, and a gradient would invent one.
      colorLow: 0xffb000,
      colorHigh: 0xffb000,
      sizeBase: 5.0,
      sizeScale: 0,
      rampLow: 0,
      rampHigh: 1,
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
    scalarUnit: 'level',
    filters: [
      { attr: 'alert_level', label: 'alert level', kind: 'enum',
        options: [
          { value: '0', label: 'green — 0' },
          { value: '1', label: 'orange — 1' },
          { value: '2', label: 'red — 2' },
        ],
        ops: ['=', '>=', '>', '<=', '<', '!='] },
      { attr: 'alert_label', label: 'event', kind: 'text', ops: ['~', '='] },
    ],
    spatialHint: { defaultRadiusKm: 1000 },
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
    // No numeric filter: event_intensity is constant by design, because EONET's
    // magnitudes are in units that cannot be compared to one another. Offering a
    // slider over it would invite a comparison the data does not support.
    filters: [{ attr: 'event_label', label: 'event', kind: 'text', ops: ['~', '='] }],
    spatialHint: { defaultRadiusKm: 1000 },
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
    name: 'weather',
    label: 'weather alerts',
    category: 'hazards',
    geoAttr: 'weather_position',
    scalarAttr: 'weather_severity',
    qlNames: ['weather', 'warnings'],
    scalarUnit: 'severity',
    filters: [
      { attr: 'weather_severity', label: 'severity', kind: 'enum',
        options: [
          { value: '0', label: 'unknown — 0' },
          { value: '1', label: 'minor — 1' },
          { value: '2', label: 'moderate — 2' },
          { value: '3', label: 'severe — 3' },
          { value: '4', label: 'extreme — 4' },
        ],
        ops: ['>=', '=', '>', '<=', '<', '!='] },
      { attr: 'weather_label', label: 'event / area', kind: 'text', ops: ['~', '='] },
    ],
    // Tornado Alley: the part of the feed most reliably carrying something.
    spatialHint: { defaultRadiusKm: 600, examplePoint: [35.5, -97.5], exampleLabel: 'Oklahoma City' },
    visual: {
      // Blue → magenta. Deliberately outside the amber-red seismic family: both
      // live in `hazards`, and a viewer must be able to tell a storm warning from
      // an earthquake without reading the legend.
      colorLow: 0x4a8fd4,
      colorHigh: 0xe0559f,
      sizeBase: 3.0,
      sizeScale: 1.1, // px per severity step
      rampLow: 0,
      rampHigh: 4,
    },
  },
  {
    name: 'aviation',
    label: 'military air',
    category: 'aviation',
    geoAttr: 'aircraft_position',
    scalarAttr: 'altitude',
    qlNames: ['aircraft', 'flights'],
    scalarUnit: 'ft',
    filters: [
      { attr: 'altitude', label: 'altitude', kind: 'number', unit: 'ft',
        min: 0, max: 60_000, step: 500 },
      // `~` first, and deliberately so: the label is "callsign · type", so an
      // equality test against a bare callsign matches nothing.
      //
      // Worth knowing while reading policy.cpp: R1-individual-narrowing fires on
      // the field NAMES `mmsi`, `id`, `callsign` and `imo`, and no source
      // declares any of them — this layer's identity-ish attribute is
      // `aircraft_label`. So the rule is reachable from the console by naming a
      // field that does not exist, but not from real data. Making it fire on the
      // data would mean declaring identity on AttrDecl the way sensitivity
      // already is, rather than matching a string in the query text.
      { attr: 'aircraft_label', label: 'callsign / type', kind: 'text', ops: ['~', '='] },
    ],
    spatialHint: { defaultRadiusKm: 400, examplePoint: [51.5, 0.0], exampleLabel: 'London' },
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
    name: 'civil',
    label: 'civil air',
    category: 'aviation',
    geoAttr: 'civil_position',
    scalarAttr: 'civil_altitude',
    qlNames: ['civil'],
    scalarUnit: 'ft',
    filters: [
      { attr: 'civil_altitude', label: 'altitude', kind: 'number', unit: 'ft',
        min: 0, max: 60_000, step: 500 },
      { attr: 'civil_label', label: 'callsign / type', kind: 'text', ops: ['~', '='] },
    ],
    spatialHint: { defaultRadiusKm: 200, examplePoint: [51.5, 0.0], exampleLabel: 'London' },
    visual: {
      // Cool blue-white against the military layer's grey-white. Same domain,
      // same shape, different affiliation — which is the distinction that
      // matters here and the only one the colour is asked to carry.
      colorLow: 0x3d6b9e,
      colorHigh: 0xdce8f5,
      sizeBase: 1.8,
      sizeScale: 0.00005,
      rampLow: 0,
      rampHigh: 40_000,
      blend: 'normal',
    },
  },
  {
    name: 'satellites',
    label: 'satellites',
    category: 'space',
    geoAttr: 'satellite_position',
    scalarAttr: 'satellite_altitude',
    qlNames: ['satellites', 'orbits'],
    scalarUnit: 'km',
    filters: [
      { attr: 'satellite_altitude', label: 'altitude', kind: 'number', unit: 'km',
        min: 100, max: 40_000, step: 100 },
      { attr: 'satellite_label', label: 'name', kind: 'text', ops: ['~', '='] },
    ],
    spatialHint: { defaultRadiusKm: 2000 },
    visual: {
      // Violet-leaning, because these facts live on the system-time side of the
      // diagonal: they were asserted before the instant they describe. Aurora is
      // green and also up there; both being cool and neither being a hazard ramp
      // is the association worth keeping.
      colorLow: 0x7a6ff0,
      colorHigh: 0xd8d2ff,
      sizeBase: 1.6,
      sizeScale: 0.00004, // barely grows — LEO and GEO must both stay legible
      rampLow: 300,
      rampHigh: 36_000,
      blend: 'normal',
    },
  },
  {
    name: 'recon',
    label: 'lookups',
    category: 'network',
    geoAttr: 'recon_position',
    scalarAttr: 'recon_label',
    qlNames: ['lookups', 'recon'],
    filters: [{ attr: 'recon_label', label: 'answer', kind: 'text', ops: ['~', '='] }],
    spatialHint: { defaultRadiusKm: 2000 },
    visual: {
      // Flat amber: there is nothing here to rank, and every point is something
      // the viewer asked for by hand rather than something a feed delivered.
      colorLow: 0xffb000,
      colorHigh: 0xffb000,
      sizeBase: 6.0,
      sizeScale: 0,
      rampLow: 0,
      rampHigh: 1,
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
    scalarUnit: '%',
    filters: [
      { attr: 'aurora_probability', label: 'probability', kind: 'number', unit: '%',
        min: 10, max: 100, step: 5 },
    ],
    spatialHint: { defaultRadiusKm: 1500, examplePoint: [69.6, 18.9], exampleLabel: 'Tromsø' },
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
// Poll cadences are set on the specs themselves rather than here, so the
// interval sits next to the note explaining why the feed moves at that rate.
export const SOURCE_SPECS: readonly SourceSpec[] = [
  usgsSpec,
  emscSpec,
  digitrafficSpec,
  gdacsSpec,
  eonetSpec,
  airplanesSpec,
  swpcSpec,
  nwsSpec,
  civilAircraftSpec,
  satellitesSpec,
  // Both read the same committed asset. Two specs rather than one because they
  // feed two separately toggleable layers, and a berth and a strait are not the
  // same kind of thing.
  portsSpec,
  chokepointsSpec,
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
