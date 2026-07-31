// ── web/src/sources/nws.ts ──────────────────────────────────────────────────
// Active US weather alerts from the National Weather Service.
//
// ── the best bitemporal fit in the catalogue ────────────────────────────────
//
// Every other feed here has to have its two axes teased apart. This one states
// them outright:
//
//   sent       when the Weather Service issued this  → SYSTEM time
//   onset      when the weather starts               → valid FROM
//   ends       when it stops                         → valid TO, bounded
//   references the alert this one replaces           → a revision, explicitly
//
// And the revisions are not hypothetical. On a live pull, 113 of 292 active
// alerts were `Update` messages carrying a reference to the alert they
// supersede — a thunderstorm warning re-issued at Severe after being issued at
// Moderate is the store's entire thesis, arriving from a government feed with
// the causal link already drawn.
//
// Note the query asks for every message type. Filtering to `message_type=alert`
// (the obvious thing, and what an earlier probe did) removes every Update — and
// with them every `references` array, which is to say all of the revisions.
//
// ── validTo is bounded, deliberately ────────────────────────────────────────
//
// A warning expires. Writing OPEN_VALID would leave last Tuesday's tornado
// warning technically still in force at every future instant on the scrubber,
// which is the same overclaim swpc.ts refuses for a forecast.
//
// ── most alerts have no shape ───────────────────────────────────────────────
//
// Measured: 26 of 176 features carried a polygon. The rest identify their area
// by UGC zone code only. Those are placed at zone centroids from a committed
// build artifact — see scripts/build-nws-zones.mjs — and one point is emitted
// PER ZONE, so a twelve-county warning looks like twelve counties rather than
// one dot in the middle of nowhere. A centroid is still not where the storm is,
// and the coverage note says so.
// ────────────────────────────────────────────────────────────────────────────
import { Kind, toTimestamp, writeF64Bits, writeGeo, writeSymBits } from '../engine/abi'
import { bucketBatches, type Batch, type EntityRegistry } from './batch'
import { SOURCES } from './registry'
import { Sensitivity, type SourceSpec } from './spec'

const ALERTS_URL = 'https://api.weather.gov/alerts/active?status=actual'
const ZONES_ASSET = 'nws/zone-centroids.json'

/** NWS severity, as a number the ramp can interpolate. */
const SEVERITY: Record<string, number> = {
  Unknown: 0,
  Minor: 1,
  Moderate: 2,
  Severe: 3,
  Extreme: 4,
}

export interface WeatherAlert {
  /** The identity this alert revises, or its own id if it revises nothing. */
  rootId: string
  event: string
  areaDesc: string
  severity: number
  /** Unix seconds — when NWS issued it. */
  sentUnix: number
  validFromUnix: number
  validToUnix: number
  /** One entry per place this alert covers. */
  points: { key: string; lat: number; lon: number }[]
}

export interface WeatherFetch {
  alerts: WeatherAlert[]
  /** Alerts dropped because no zone in them had a known centroid. */
  unplaced: number
}

type Centroids = Record<string, [number, number]>

let centroidCache: Centroids | null = null

async function loadCentroids(signal?: AbortSignal): Promise<Centroids> {
  if (centroidCache) return centroidCache
  const url = `${import.meta.env.BASE_URL}${ZONES_ASSET}`
  const res = await fetch(url, signal ? { signal } : {})
  if (!res.ok) throw new Error(`zone centroids ${res.status}`)
  centroidCache = (await res.json()) as Centroids
  return centroidCache
}

function isoToUnix(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? Math.floor(t / 1000) : null
}

/**
 * Follows the supersession chain to the identity being revised.
 *
 * Keyed on the ROOT rather than on each message's own id, so a warning issued,
 * upgraded and upgraded again is one entity with three versions — which is what
 * the inspector's history view was built to show — rather than three unrelated
 * dots sitting on top of each other.
 *
 * The cycle guard is not paranoia about NWS: `parent` is built from whatever the
 * feed says, and a self-reference would hang the ingest cycle rather than fail it.
 */
function rootOf(id: string, parent: ReadonlyMap<string, string>): string {
  const seen = new Set<string>([id])
  let cur = id
  for (;;) {
    const next = parent.get(cur)
    if (next === undefined || seen.has(next)) return cur
    seen.add(next)
    cur = next
  }
}

export async function fetchWeather(signal?: AbortSignal): Promise<WeatherFetch> {
  const [centroids, res] = await Promise.all([
    loadCentroids(signal),
    // No User-Agent header: it is a forbidden header name for fetch(), so the
    // browser supplies its own. NWS asks scripts to identify themselves and
    // accepts browser traffic without it — verified against the live endpoint.
    fetch(ALERTS_URL, {
      headers: { Accept: 'application/geo+json' },
      ...(signal ? { signal } : {}),
    }),
  ])
  if (!res.ok) throw new Error(`weather.gov ${res.status}`)

  const body = (await res.json()) as {
    features?: {
      properties?: Record<string, unknown>
      geometry?: { type?: string; coordinates?: unknown } | null
    }[]
  }
  const features = body.features ?? []

  // Built over the whole payload first: an Update can appear before the alert it
  // references, so resolving roots inline would depend on array order.
  const parent = new Map<string, string>()
  for (const f of features) {
    const p = f.properties ?? {}
    const id = typeof p.id === 'string' ? p.id : null
    const refs = Array.isArray(p.references) ? p.references : []
    const first = refs[0] as { identifier?: unknown } | undefined
    if (id && typeof first?.identifier === 'string') parent.set(id, first.identifier)
  }

  const alerts: WeatherAlert[] = []
  let unplaced = 0

  for (const f of features) {
    const p = f.properties ?? {}
    const id = typeof p.id === 'string' ? p.id : null
    if (!id) continue

    const sentUnix = isoToUnix(p.sent)
    const validFromUnix = isoToUnix(p.onset) ?? isoToUnix(p.effective) ?? sentUnix
    // `ends` is the real end; `expires` is when the message goes stale. Either is
    // a bound, and a bound is the point.
    const validToUnix = isoToUnix(p.ends) ?? isoToUnix(p.expires)
    if (sentUnix === null || validFromUnix === null || validToUnix === null) continue
    // A window that ends before it starts is not something to plot at a guess.
    if (validToUnix <= validFromUnix) continue

    const points: WeatherAlert['points'] = []

    // A real polygon beats a centroid whenever there is one.
    const geom = f.geometry
    if (geom && geom.type === 'Polygon' && Array.isArray(geom.coordinates)) {
      const ring = (geom.coordinates as number[][][])[0]
      if (Array.isArray(ring) && ring.length >= 3) {
        let lat = 0
        let lon = 0
        for (const c of ring) {
          lon += c[0]!
          lat += c[1]!
        }
        points.push({ key: 'poly', lat: lat / ring.length, lon: lon / ring.length })
      }
    }

    if (points.length === 0) {
      const geocode = p.geocode as { UGC?: unknown } | undefined
      const ugc = Array.isArray(geocode?.UGC) ? (geocode.UGC as string[]) : []
      for (const zone of ugc) {
        const c = centroids[zone]
        if (c) points.push({ key: zone, lat: c[0], lon: c[1] })
      }
    }

    if (points.length === 0) {
      // Counted, never plotted at (0, 0). An alert at null island is worse than
      // an alert that is honestly absent.
      unplaced++
      continue
    }

    alerts.push({
      rootId: rootOf(id, parent),
      event: typeof p.event === 'string' ? p.event : 'Alert',
      areaDesc: typeof p.areaDesc === 'string' ? p.areaDesc : '',
      severity: SEVERITY[String(p.severity)] ?? 0,
      sentUnix,
      validFromUnix,
      validToUnix,
      points,
    })
  }

  return { alerts, unplaced }
}

interface WeatherAttrs {
  position: number
  severity: number
  label: number
}

export function buildWeatherBatches(
  alerts: readonly WeatherAlert[],
  registry: EntityRegistry,
  attrs: WeatherAttrs,
  intern: (text: string) => number,
): Batch[] {
  return bucketBatches(
    alerts,
    // System time is the feed's own `sent`, never a fetch clock — which is what
    // makes a re-issued warning a revision rather than a new thing we just saw.
    (a) => a.sentUnix,
    (a, push) => {
      const validFrom = toTimestamp(a.validFromUnix)
      const validTo = toTimestamp(a.validToUnix)
      const label = intern(a.areaDesc ? `${a.event} — ${a.areaDesc}` : a.event)

      for (const pt of a.points) {
        // Per (revision root, place). An update covering the same zones writes
        // over the same entities, so the inspector shows Moderate → Severe as
        // one thing changing rather than two things overlapping.
        const entity = registry.idFor(`nws:${a.rootId}:${pt.key}`)

        push({
          entity,
          attr: attrs.position,
          kind: Kind.Geo,
          validFrom,
          validTo,
          source: SOURCES.nws!.id,
          writePayload: (view, off) => writeGeo(view, off, pt.lat, pt.lon),
        })
        push({
          entity,
          attr: attrs.severity,
          kind: Kind.F64,
          validFrom,
          validTo,
          source: SOURCES.nws!.id,
          writePayload: (view, off) => writeF64Bits(view, off, a.severity),
        })
        push({
          entity,
          attr: attrs.label,
          kind: Kind.Sym,
          validFrom,
          validTo,
          source: SOURCES.nws!.id,
          writePayload: (view, off) => writeSymBits(view, off, label),
        })
      }
    },
  )
}

export const nwsSpec: SourceSpec<WeatherFetch> = {
  id: SOURCES.nws!.id,
  key: 'nws',
  label: 'weather · nws',
  layer: 'weather',
  assets: [ZONES_ASSET],
  coverageNote:
    'United States only. Most alerts carry no shape and are drawn at the centroid of each zone they name — a centroid is not where the storm is.',
  // Warnings are re-issued and upgraded continuously; two minutes is fast enough
  // to catch an upgrade while it still matters and slow enough to be polite.
  pollSeconds: 120,
  attributes: [
    { name: 'weather_position', sensitivity: Sensitivity.Public },
    { name: 'weather_severity', sensitivity: Sensitivity.Public },
    { name: 'weather_label', sensitivity: Sensitivity.Public },
  ],
  fetch: (signal) => fetchWeather(signal),
  normalize(raw, ctx) {
    return {
      batches: buildWeatherBatches(
        raw.alerts,
        ctx.registry,
        {
          position: ctx.attrs.weather_position!,
          severity: ctx.attrs.weather_severity!,
          label: ctx.attrs.weather_label!,
        },
        ctx.intern,
      ),
      count: raw.alerts.length,
    }
  },
}
