// ── web/src/sources/eonet.ts ────────────────────────────────────────────────
// NASA EONET — Earth Observatory Natural Event Tracker.
//
//   https://eonet.gsfc.nasa.gov/api/v3/events
//   US Government work, public domain. Keyless, CORS-open.
//
// Wildfires, volcanoes, severe storms, and sea/lake ice, curated by NASA from
// its own instruments and partner agencies.
//
// ── the scalar is deliberately flat ────────────────────────────────────────
//
// EONET reports a magnitude for most events, but the UNITS are not comparable:
// wildfires in acres, storms in knots, ice in square nautical miles. Feeding
// those into one colour ramp would make a 600-acre brush fire outrank a 90-knot
// cyclone because 600 > 90, which is not a fact about the world — it is a fact
// about unit choice.
//
// So every event renders at the same size and the layer says so in the panel.
// A uniform dot that means "an event is here" is honest; a graded one that means
// "these numbers were in the same JSON field" is not. Splitting into one layer
// per category with its own ramp is the real fix, and is worth doing when the
// non-wildfire categories carry more than a dozen events between them.
//
// ── system time ────────────────────────────────────────────────────────────
//
// EONET publishes no revision timestamp. There is no separate "when we learned
// it", so ingest time is the honest system axis and these facts sit on the
// scrubber's diagonal — the same treatment AIS gets, for the same reason. The
// README's rule applies: if a revision is not in the data, it does not go on
// the axis.
// ────────────────────────────────────────────────────────────────────────────
import { Kind, OPEN_VALID, toTimestamp, writeF64Bits, writeGeo } from '../engine/abi'
import { bucketBatches, type Batch, type EntityRegistry } from './batch'
import { SOURCES } from './registry'
import { Sensitivity, type SourceSpec } from './spec'

export const EONET_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=500'

export interface EonetEvent {
  id: string
  lat: number
  lon: number
  category: string
  title: string
  /** When the event was observed — valid time. */
  timeUnix: number
}

function isoToUnix(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export async function fetchEonet(
  url: string = EONET_URL,
  signal?: AbortSignal,
): Promise<{ events: EonetEvent[]; rejected: number }> {
  const res = await fetch(url, signal ? { signal } : {})
  if (!res.ok) throw new Error(`EONET returned ${res.status} ${res.statusText}`)

  const body: unknown = await res.json()
  const list: unknown = (body as { events?: unknown })?.events
  if (!Array.isArray(list)) throw new Error('EONET returned no events array')

  const events: EonetEvent[] = []
  let rejected = 0

  for (const raw of list) {
    const e = raw as {
      id?: unknown
      title?: unknown
      categories?: { title?: unknown }[]
      geometry?: { type?: unknown; coordinates?: unknown; date?: unknown }[]
    }
    const geometry = Array.isArray(e.geometry) ? e.geometry : []
    // An event can carry a track of many positions. The LAST is where it is now,
    // which is what a current-state map should show.
    const g = geometry.at(-1)
    const coords = g?.coordinates

    if (!g || g.type !== 'Point' || !Array.isArray(coords) || coords.length < 2) {
      // Polygon events (some storms and ice) are skipped rather than reduced to
      // a centroid that would put an iceberg's dot in open water.
      rejected++
      continue
    }

    const lon = num(coords[0])
    const lat = num(coords[1])
    const time = isoToUnix(g.date)
    if (lat === null || lon === null || time === null) {
      rejected++
      continue
    }

    events.push({
      id: `eonet:${String(e.id ?? '')}`,
      lat,
      lon,
      category: String(e.categories?.[0]?.title ?? 'Unknown'),
      title: String(e.title ?? ''),
      timeUnix: time,
    })
  }

  return { events, rejected }
}

export interface EonetAttrs {
  position: number
  intensity: number
}

export function buildEonetBatches(
  events: readonly EonetEvent[],
  registry: EntityRegistry,
  attrs: EonetAttrs,
  nowUnix: number,
): Batch[] {
  return bucketBatches(
    events,
    // No revision field exists, so system time is when this client learned it.
    () => nowUnix,
    (e, push) => {
      const entity = registry.idFor(e.id)
      const validFrom = toTimestamp(e.timeUnix)

      push({
        entity,
        attr: attrs.position,
        kind: Kind.Geo,
        validFrom,
        validTo: OPEN_VALID,
        source: SOURCES.eonet!.id,
        writePayload: (v, off) => writeGeo(v, off, e.lat, e.lon),
      })
      push({
        entity,
        attr: attrs.intensity,
        kind: Kind.F64,
        validFrom,
        validTo: OPEN_VALID,
        source: SOURCES.eonet!.id,
        // Flat by design — see the header. The attribute exists so the layer has
        // a scalar to bind, not because the number carries information.
        writePayload: (v, off) => writeF64Bits(v, off, 1),
      })
    },
  )
}

// ── source spec ─────────────────────────────────────────────────────────────

export const eonetSpec: SourceSpec<{ events: EonetEvent[]; rejected: number }> = {
  id: SOURCES.eonet!.id,
  key: 'eonet',
  label: 'natural events · eonet',
  layer: 'events',
  coverageNote: 'wildfires, volcanoes, storms, ice — uniform size, units differ',
  attributes: [
    { name: 'event_position', sensitivity: Sensitivity.Public },
    { name: 'event_intensity', sensitivity: Sensitivity.Public },
  ],
  fetch: (signal) => fetchEonet(EONET_URL, signal),
  normalize(raw, ctx) {
    return {
      batches: buildEonetBatches(
        raw.events,
        ctx.registry,
        {
          position: ctx.attrs.event_position!,
          intensity: ctx.attrs.event_intensity!,
        },
        Math.floor(Date.now() / 1000),
      ),
      count: raw.events.length,
    }
  },
}
