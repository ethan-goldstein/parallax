// ── web/src/sources/usgs.ts ─────────────────────────────────────────────────
// USGS earthquake feed.
//
//   https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/
//   License: US Government work, public domain.
//   CORS: Access-Control-Allow-Origin: * — callable directly from the browser,
//   no key, no proxy, nothing that can expire.
//
// ── where the system-time axis actually comes from ─────────────────────────
//
// This is the honest part, and it is worth being explicit about because the
// dishonest version is easy and looks identical from the outside.
//
// Every USGS feature carries TWO timestamps:
//   properties.time    — when the earthquake happened          → VALID time
//   properties.updated — when USGS last revised the record     → SYSTEM time
//
// That second field is real. USGS publishes an automated magnitude within
// seconds of an event and revises it as human analysts review the seismograms;
// `updated` moves when they do. So the system-time axis is not simulated,
// interpolated, or invented — it is USGS's own record of when each estimate
// became current.
//
// The tempting shortcut would be to fabricate transactions (bucket by event
// time, or drip records in on a timer) so the scrubber has something to move
// through on first load. That would be exactly the class of thing the
// reference site does when it labels recycled flight data as a live SDK feed.
// If a revision is not in the data, it does not go on the axis.
//
// The consequence is honest but worth knowing: a feed window in which USGS
// revised nothing produces few transactions, and the system axis is
// correspondingly short. That is the truth about the data.
// ────────────────────────────────────────────────────────────────────────────
import { Kind, OPEN_VALID, toTimestamp, writeF64Bits, writeGeo, writeSymBits } from '../engine/abi'
import type { FactInput } from '../engine/engine'
import type { Batch } from './batch'
import { EntityRegistry } from './batch'
import { SOURCES } from './registry'
import { Sensitivity, type SourceSpec } from './spec'

export const USGS_FEEDS = {
  hour: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson',
  day: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
  week: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson',
  significantMonth:
    'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_month.geojson',
} as const

export const USGS_ATTRIBUTION = {
  name: 'USGS Earthquake Hazards Program',
  url: 'https://earthquake.usgs.gov/earthquakes/feed/',
  license: 'Public domain (US Government work)',
  spdx: 'CC-PDDC',
} as const

interface UsgsFeature {
  id?: unknown
  properties?: {
    mag?: unknown
    time?: unknown
    updated?: unknown
    place?: unknown
  }
  geometry?: {
    coordinates?: unknown
  }
}

/** One earthquake, after validation. */
export interface Quake {
  id: string
  lat: number
  lon: number
  depthKm: number
  magnitude: number | null
  timeUnix: number // valid time — when it happened
  updatedUnix: number // system time — when USGS last revised this record
  place: string
}

export interface FetchResult {
  quakes: Quake[]
  fetchedAtUnix: number
  rejected: number
}

/**
 * A batch of facts sharing one system time — one transaction.
 */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

export async function fetchQuakes(
  url: string = USGS_FEEDS.day,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const res = await fetch(url, signal ? { signal } : {})
  if (!res.ok) {
    throw new Error(`USGS feed returned ${res.status} ${res.statusText}`)
  }

  const body: unknown = await res.json()
  const features: unknown = (body as { features?: unknown })?.features
  if (!Array.isArray(features)) {
    throw new Error('USGS feed had no features array')
  }

  const quakes: Quake[] = []
  let rejected = 0

  for (const raw of features as UsgsFeature[]) {
    const p = raw?.properties
    const coords = raw?.geometry?.coordinates

    // Validate rather than trust. This is third-party data arriving over the
    // network: it is untrusted input, and one malformed feature must not take
    // out the other few hundred. Nulls here are not hypothetical — USGS
    // genuinely publishes features with mag: null before a magnitude is
    // assigned.
    if (!Array.isArray(coords) || coords.length < 2) {
      rejected++
      continue
    }
    const lon = coords[0]
    const lat = coords[1]
    const depth = coords.length > 2 ? coords[2] : 0

    if (!isFiniteNumber(lon) || !isFiniteNumber(lat)) {
      rejected++
      continue
    }
    if (!isFiniteNumber(p?.time)) {
      rejected++
      continue
    }
    if (typeof raw.id !== 'string' || raw.id.length === 0) {
      rejected++
      continue
    }

    const timeUnix = Math.floor(p.time / 1000)
    const updatedUnix = isFiniteNumber(p?.updated) ? Math.floor(p.updated / 1000) : timeUnix

    quakes.push({
      id: raw.id,
      lat,
      lon,
      depthKm: isFiniteNumber(depth) ? depth : 0,
      magnitude: isFiniteNumber(p?.mag) ? p.mag : null,
      timeUnix,
      updatedUnix,
      place: typeof p?.place === 'string' ? p.place : 'unknown',
    })
  }

  return { quakes, fetchedAtUnix: Math.floor(Date.now() / 1000), rejected }
}

/**
 * Assigns dense, sequential entity ids.
 *
 * Density is a hard requirement, not a preference. Store::rebuild_entity_index
 * builds a CSR offset array of length max_entity + 2, so hashing an event id
 * to a random u32 would ask the engine to allocate four billion entries and
 * take the tab down. Sequential ids keep that array exactly as large as the
 * number of distinct entities.
 */
export interface AttrIds {
  position: number
  magnitude: number
  depth: number
  /** SymbolId of the human-readable place, e.g. "46 km E of Petropavlovsk". */
  label: number
}

/**
 * Groups quakes into transactions by their `updated` timestamp, ascending.
 *
 * Each distinct revision instant becomes one point on the system-time axis, so
 * dragging that axis backwards replays USGS's own publication history: records
 * revised later disappear, and the world reverts to what was known earlier.
 *
 * Bucketed to the minute. USGS timestamps are millisecond-precision and a bulk
 * review pass will stamp dozens of records within the same few seconds;
 * without bucketing those become dozens of adjacent transactions that are
 * indistinguishable on the axis but cost a full store commit each.
 */
export function buildBatches(
  quakes: readonly Quake[],
  registry: EntityRegistry,
  attrs: AttrIds,
  intern: (text: string) => number,
  sourceId = 0,
): Batch[] {
  const BUCKET_SECONDS = 60

  const byBucket = new Map<number, Quake[]>()
  for (const q of quakes) {
    const bucket = Math.floor(q.updatedUnix / BUCKET_SECONDS) * BUCKET_SECONDS
    let list = byBucket.get(bucket)
    if (!list) {
      list = []
      byBucket.set(bucket, list)
    }
    list.push(q)
  }

  const buckets = [...byBucket.keys()].sort((a, b) => a - b)

  return buckets.map((bucket) => {
    const facts: FactInput[] = []

    for (const q of byBucket.get(bucket)!) {
      const entity = registry.idFor(q.id)

      // An earthquake, once it has happened, stays true forever — so valid_to
      // is the open sentinel. What changes is our *belief* about it, and that
      // is carried entirely on the system axis. This is precisely the
      // distinction a single-timestamp store cannot express.
      const validFrom = toTimestamp(q.timeUnix)

      facts.push({
        entity,
        attr: attrs.position,
        kind: Kind.Geo,
        validFrom,
        validTo: OPEN_VALID,
        source: sourceId,
        writePayload: (v, off) => writeGeo(v, off, q.lat, q.lon),
      })

      if (q.magnitude !== null) {
        facts.push({
          entity,
          attr: attrs.magnitude,
          kind: Kind.F64,
          validFrom,
          validTo: OPEN_VALID,
          source: sourceId,
          writePayload: (v, off) => writeF64Bits(v, off, q.magnitude!),
        })
      }

      facts.push({
        entity,
        attr: attrs.depth,
        kind: Kind.F64,
        validFrom,
        validTo: OPEN_VALID,
        source: sourceId,
        writePayload: (v, off) => writeF64Bits(v, off, q.depthKm),
      })

      // The place string is what makes a dot legible — "46 km E of
      // Petropavlovsk" rather than `us7000abcd`. It is stored as a fact rather
      // than kept in a client-side table so it carries this source and this
      // licence, and so scrubbing the system axis shows the description USGS
      // was publishing at that time.
      if (q.place.length > 0) {
        const sym = intern(q.place)
        facts.push({
          entity,
          attr: attrs.label,
          kind: Kind.Sym,
          validFrom,
          validTo: OPEN_VALID,
          source: sourceId,
          writePayload: (v, off) => writeSymBits(v, off, sym),
        })
      }
    }

    return { wallClockUnix: bucket, facts }
  })
}

// ── source spec ─────────────────────────────────────────────────────────────

/**
 * USGS as a registered source.
 *
 * `position` is typed Public because an earthquake has no privacy interest, and
 * a policy engine that pretended otherwise would be theatre — the refusal table
 * in the README turns on exactly this asymmetry against vessel positions.
 */
export const usgsSpec: SourceSpec<FetchResult> = {
  id: SOURCES.usgs!.id,
  key: 'usgs',
  label: 'seismic · usgs',
  layer: 'seismic',
  // Revisions are what matter here, not new events: USGS re-solves a magnitude
  // over the following hours, and each re-solve carries a new `updated` — which
  // becomes a new transaction on the system axis and a genuine revision in the
  // store. This is the feed that makes the scrubber's Y axis mean something.
  pollSeconds: 120,
  attributes: [
    { name: 'position', sensitivity: Sensitivity.Public },
    { name: 'magnitude', sensitivity: Sensitivity.Public },
    { name: 'depth', sensitivity: Sensitivity.Public },
    { name: 'label', sensitivity: Sensitivity.Public },
  ],
  fetch: (signal) => fetchQuakes(USGS_FEEDS.week, signal),
  normalize(raw, ctx) {
    const attrs = {
      position: ctx.attrs.position!,
      magnitude: ctx.attrs.magnitude!,
      depth: ctx.attrs.depth!,
      label: ctx.attrs.label!,
    }
    return {
      batches: buildBatches(raw.quakes, ctx.registry, attrs, ctx.intern, SOURCES.usgs!.id),
      count: raw.quakes.length,
    }
  },
}
