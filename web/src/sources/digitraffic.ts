// ── web/src/sources/digitraffic.ts ──────────────────────────────────────────
// Finnish Transport Infrastructure Agency AIS, via Digitraffic.
//
//   https://meri.digitraffic.fi/api/ais/v1/locations
//   License: CC BY 4.0 — attribution required, and it is rendered in the UI.
//   CORS: Access-Control-Allow-Origin: * — direct browser fetch, no key.
//
// This is the only AIS source in this project that is unambiguously legal to
// redisplay publicly with no key and no proxy. The alternatives were checked
// and rejected:
//
//   AISStream      — free, but the key would have to live in the browser,
//                    where it is public. Their own docs say so.
//   MarineTraffic  — explicit ToS prohibition on scraping. Also the single
//                    worst signal to send a defense-adjacent employer.
//   Kystverket(NO) — NLOD-licensed and genuinely open, but the free feed is
//                    raw AIVDM over a TCP socket, which a browser cannot open.
//
// Coverage is the Baltic and Gulf of Finland, not the globe. That is a real
// limitation and the UI says so rather than implying worldwide AIS — which is
// exactly the overclaim that makes the reference site's empty "LIVE SHIPS: 0"
// labels so damaging to its credibility.
//
// NOTE on Accept-Encoding: the API returns 406 without gzip, which trips up
// curl and server-side clients. Browsers always send Accept-Encoding
// automatically and the header is forbidden to set from fetch(), so there is
// nothing to do here — verified working from the deployed origin.
// ────────────────────────────────────────────────────────────────────────────
import { Kind, OPEN_VALID, toTimestamp, writeF64Bits, writeGeo } from '../engine/abi'
import type { FactInput } from '../engine/engine'
import type { Batch, EntityRegistry } from './usgs'
import { SOURCES } from './registry'

export const DIGITRAFFIC_AIS_URL = 'https://meri.digitraffic.fi/api/ais/v1/locations'

export interface Vessel {
  mmsi: number
  lat: number
  lon: number
  /** Speed over ground, knots. 102.3 is the AIS "not available" sentinel. */
  sogKnots: number | null
  /** Course over ground, degrees. 360 is the AIS "not available" sentinel. */
  cogDegrees: number | null
  /** Report timestamp, unix seconds — this is the VALID time of the position. */
  timeUnix: number
}

export interface VesselFetch {
  vessels: Vessel[]
  rejected: number
}

interface RawFeature {
  mmsi?: unknown
  geometry?: { coordinates?: unknown }
  properties?: { sog?: unknown; cog?: unknown; timestampExternal?: unknown }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export async function fetchVessels(
  url: string = DIGITRAFFIC_AIS_URL,
  signal?: AbortSignal,
): Promise<VesselFetch> {
  const res = await fetch(url, signal ? { signal } : {})
  if (!res.ok) throw new Error(`Digitraffic AIS returned ${res.status} ${res.statusText}`)

  const body: unknown = await res.json()
  const features: unknown = (body as { features?: unknown })?.features
  if (!Array.isArray(features)) throw new Error('Digitraffic AIS had no features array')

  const vessels: Vessel[] = []
  let rejected = 0

  for (const raw of features as RawFeature[]) {
    const coords = raw?.geometry?.coordinates
    const mmsi = num(raw?.mmsi)

    if (!Array.isArray(coords) || coords.length < 2 || mmsi === null) {
      rejected++
      continue
    }
    const lon = num(coords[0])
    const lat = num(coords[1])
    if (lon === null || lat === null) {
      rejected++
      continue
    }

    // AIS reports arrive in milliseconds. A vessel with no timestamp cannot be
    // placed on the valid-time axis at all, so it is dropped rather than
    // silently stamped with "now" — inventing a time is exactly the kind of
    // quiet fabrication this project is arguing against.
    const tsMs = num(raw?.properties?.timestampExternal)
    if (tsMs === null) {
      rejected++
      continue
    }

    const sog = num(raw?.properties?.sog)
    const cog = num(raw?.properties?.cog)

    vessels.push({
      mmsi,
      lat,
      lon,
      // 102.3 and 360 are the AIS spec's "not available" encodings, not real
      // measurements. Storing them as numbers would put a 102-knot vessel on
      // the map.
      sogKnots: sog !== null && sog < 102.3 ? sog : null,
      cogDegrees: cog !== null && cog < 360 ? cog : null,
      timeUnix: Math.floor(tsMs / 1000),
    })
  }

  return { vessels, rejected }
}

export interface VesselAttrs {
  position: number
  speed: number
}

/**
 * One transaction per report-time bucket.
 *
 * Unlike USGS, AIS has no separate "revised at" field — a position report is
 * published once and never corrected. So valid time and system time coincide
 * here, and the honest thing is to say so: these facts sit ON the scrubber's
 * diagonal, which is precisely what the "recorded as it happened" reference
 * line means. Manufacturing a spread between the two axes would be inventing
 * data.
 *
 * The vessel's position is valid from its report onward (valid_to open). A
 * later poll supersedes it by retracting and re-asserting, which is what will
 * put AIS genuinely above and below the diagonal once polling lands.
 */
export function buildVesselBatches(
  vessels: readonly Vessel[],
  registry: EntityRegistry,
  attrs: VesselAttrs,
): Batch[] {
  const BUCKET_SECONDS = 60
  const byBucket = new Map<number, Vessel[]>()

  for (const v of vessels) {
    const bucket = Math.floor(v.timeUnix / BUCKET_SECONDS) * BUCKET_SECONDS
    let list = byBucket.get(bucket)
    if (!list) {
      list = []
      byBucket.set(bucket, list)
    }
    list.push(v)
  }

  const source = SOURCES.digitraffic!.id

  return [...byBucket.keys()]
    .sort((a, b) => a - b)
    .map((bucket) => {
      const facts: FactInput[] = []

      for (const v of byBucket.get(bucket)!) {
        // Namespaced key: MMSI is unique within AIS but a bare number could
        // collide with a USGS event id in the shared entity registry.
        const entity = registry.idFor(`mmsi:${v.mmsi}`)
        const validFrom = toTimestamp(v.timeUnix)

        facts.push({
          entity,
          attr: attrs.position,
          kind: Kind.Geo,
          validFrom,
          validTo: OPEN_VALID,
          source,
          writePayload: (view, off) => writeGeo(view, off, v.lat, v.lon),
        })

        if (v.sogKnots !== null) {
          facts.push({
            entity,
            attr: attrs.speed,
            kind: Kind.F64,
            validFrom,
            validTo: OPEN_VALID,
            source,
            writePayload: (view, off) => writeF64Bits(view, off, v.sogKnots!),
          })
        }
      }

      return { wallClockUnix: bucket, facts }
    })
}
