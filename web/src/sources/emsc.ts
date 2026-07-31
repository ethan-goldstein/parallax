// ── web/src/sources/emsc.ts ─────────────────────────────────────────────────
// EMSC — European-Mediterranean Seismological Centre, via the seismicportal.eu
// FDSN web service.
//
//   https://seismicportal.eu/fdsnws/event/1/query?format=json
//   CORS: open. No key.
//
// ── why this source specifically ───────────────────────────────────────────
//
// EMSC exists here to create a REAL entity-resolution problem rather than a
// demonstrated one. It and USGS independently locate the same earthquakes,
// using different station networks and different magnitude scales, and publish
// them under different ids with no join key between them:
//
//   USGS  us7000abcd   38.4528 N  16.0093 E   M 2.1 (ml)   23:51:08.07Z
//   EMSC  20260730_…   38.5100 N  15.9500 E   M 2.3 (mw)   23:51:12Z
//
// Same rupture. Different everything. Deciding they are one event is exactly
// the problem px/er.hpp solves, and no part of it is synthetic — which matters,
// because an ER demo over fabricated near-duplicates proves nothing about
// whether the model works on real disagreement.
//
// EMSC also publishes `lastupdate` separately from `time`, so like USGS it
// carries its own system-time axis.
// ────────────────────────────────────────────────────────────────────────────
import { Kind, OPEN_VALID, toTimestamp, writeF64Bits, writeGeo } from '../engine/abi'
import type { FactInput } from '../engine/engine'
import { SOURCES } from './registry'
import type { Batch, EntityRegistry } from './usgs'

export const EMSC_URL =
  'https://seismicportal.eu/fdsnws/event/1/query?limit=800&format=json&orderby=time'

export interface EmscEvent {
  id: string
  lat: number
  lon: number
  depthKm: number
  magnitude: number | null
  magType: string
  timeUnix: number
  /** When EMSC last revised the record — its system-time axis. */
  updatedUnix: number
  region: string
}

interface RawFeature {
  id?: unknown
  properties?: {
    lat?: unknown
    lon?: unknown
    depth?: unknown
    mag?: unknown
    magtype?: unknown
    time?: unknown
    lastupdate?: unknown
    flynn_region?: unknown
    unid?: unknown
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** ISO-8601 to unix seconds, or null. EMSC timestamps are always UTC. */
function isoToUnix(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

export async function fetchEmsc(
  url: string = EMSC_URL,
  signal?: AbortSignal,
): Promise<{ events: EmscEvent[]; rejected: number }> {
  const res = await fetch(url, signal ? { signal } : {})
  if (!res.ok) throw new Error(`EMSC returned ${res.status} ${res.statusText}`)

  const body: unknown = await res.json()
  const features: unknown = (body as { features?: unknown })?.features
  if (!Array.isArray(features)) throw new Error('EMSC returned no features array')

  const events: EmscEvent[] = []
  let rejected = 0

  for (const raw of features as RawFeature[]) {
    const p = raw?.properties
    const lat = num(p?.lat)
    const lon = num(p?.lon)
    const time = isoToUnix(p?.time)

    // Third-party data over the network is untrusted input. A record missing a
    // position or a time cannot be placed on either axis, so it is counted and
    // dropped rather than defaulted — inventing a timestamp is exactly the kind
    // of quiet fabrication this project argues against.
    if (lat === null || lon === null || time === null) {
      rejected++
      continue
    }

    const id =
      typeof p?.unid === 'string'
        ? p.unid
        : typeof raw.id === 'string'
          ? raw.id
          : `${lat},${lon},${time}`

    events.push({
      id,
      lat,
      lon,
      depthKm: num(p?.depth) ?? 0,
      magnitude: num(p?.mag),
      magType: typeof p?.magtype === 'string' ? p.magtype : '',
      timeUnix: time,
      updatedUnix: isoToUnix(p?.lastupdate) ?? time,
      region: typeof p?.flynn_region === 'string' ? p.flynn_region : '',
    })
  }

  return { events, rejected }
}

export interface EmscAttrs {
  position: number
  magnitude: number
  depth: number
  region: number
}

/**
 * One transaction per revision-time bucket, matching the USGS treatment so
 * both agencies share one honest system-time axis.
 */
export function buildEmscBatches(
  events: readonly EmscEvent[],
  registry: EntityRegistry,
  attrs: EmscAttrs,
): Batch[] {
  const BUCKET_SECONDS = 60
  const byBucket = new Map<number, EmscEvent[]>()

  for (const e of events) {
    const bucket = Math.floor(e.updatedUnix / BUCKET_SECONDS) * BUCKET_SECONDS
    let list = byBucket.get(bucket)
    if (!list) {
      list = []
      byBucket.set(bucket, list)
    }
    list.push(e)
  }

  const source = SOURCES.emsc!.id

  return [...byBucket.keys()]
    .sort((a, b) => a - b)
    .map((bucket) => {
      const facts: FactInput[] = []

      for (const e of byBucket.get(bucket)!) {
        // Namespaced so an EMSC id can never collide with a USGS one in the
        // shared registry. Whether the two describe the same quake is exactly
        // the question entity resolution answers — it must NOT be assumed here
        // by giving them a shared key.
        const entity = registry.idFor(`emsc:${e.id}`)
        const validFrom = toTimestamp(e.timeUnix)

        facts.push({
          entity,
          attr: attrs.position,
          kind: Kind.Geo,
          validFrom,
          validTo: OPEN_VALID,
          source,
          writePayload: (v, off) => writeGeo(v, off, e.lat, e.lon),
        })

        if (e.magnitude !== null) {
          facts.push({
            entity,
            attr: attrs.magnitude,
            kind: Kind.F64,
            validFrom,
            validTo: OPEN_VALID,
            source,
            writePayload: (v, off) => writeF64Bits(v, off, e.magnitude!),
          })
        }

        facts.push({
          entity,
          attr: attrs.depth,
          kind: Kind.F64,
          validFrom,
          validTo: OPEN_VALID,
          source,
          writePayload: (v, off) => writeF64Bits(v, off, e.depthKm),
        })
      }

      return { wallClockUnix: bucket, facts }
    })
}
