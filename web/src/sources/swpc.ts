// ── web/src/sources/swpc.ts ─────────────────────────────────────────────────
// NOAA SWPC — OVATION aurora probability forecast.
//
//   https://services.swpc.noaa.gov/json/ovation_aurora_latest.json
//   US Government work, public domain. Keyless, CORS-open.
//
// ── this is the only source that lands ABOVE the diagonal ──────────────────
//
// scrubber.ts has said since Phase 4 that everything above the diagonal is
// "knowledge about the future — forecasts, predicted orbits". Until now that
// half of the plane was empty, because every other feed reports things that
// already happened.
//
// OVATION reports two instants explicitly:
//
//   Observation Time  02:41Z   the solar wind measurement it was computed from
//   Forecast Time     04:04Z   the instant the probability is ABOUT
//
// Those map onto the two axes exactly: observation is system time, forecast is
// valid time, and forecast is roughly 80 minutes AHEAD. So these facts are
// asserted before the interval they describe, which is what "known before it
// happened" means and what the upper region of the scrubber was drawn for.
//
// Nothing is simulated to achieve that. Both instants are fields in the feed.
//
// ── validity is bounded, unlike everything else here ───────────────────────
//
// Every other source asserts with an open valid_to: an earthquake, once it has
// happened, stays true forever. A forecast does not. A 04:04Z aurora
// probability is not a claim about 09:00Z, so valid_to closes 30 minutes out.
// Leaving it open would make a stale forecast look like a standing fact.
// ────────────────────────────────────────────────────────────────────────────
import { Kind, toTimestamp, writeF64Bits, writeGeo } from '../engine/abi'
import { bucketBatches, type Batch, type EntityRegistry } from './batch'
import { SOURCES } from './registry'
import { Sensitivity, type SourceSpec } from './spec'

export const SWPC_AURORA_URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json'

/**
 * Minimum probability to ingest.
 *
 * The grid is 1° × 1° over the whole planet — 65,160 cells, of which ~18,000 are
 * non-zero on an average night. Most of those are 1–4%, which is indistinguishable
 * from nothing and would bury both poles in dots. 10% is where the oval starts
 * being a shape rather than a haze.
 */
const MIN_PROBABILITY = 10

/** How long a forecast cell is treated as describing. */
const FORECAST_VALID_SECONDS = 1800

export interface AuroraCell {
  lat: number
  lon: number
  /** Probability of visible aurora, 0–100. */
  probability: number
}

export interface AuroraFetch {
  cells: AuroraCell[]
  /** When the driving observation was taken — system time. */
  observedUnix: number
  /** The instant the forecast is about — valid time, ahead of observation. */
  forecastUnix: number
  rejected: number
}

function isoToUnix(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

export async function fetchAurora(
  url: string = SWPC_AURORA_URL,
  signal?: AbortSignal,
): Promise<AuroraFetch> {
  const res = await fetch(url, signal ? { signal } : {})
  if (!res.ok) throw new Error(`SWPC returned ${res.status} ${res.statusText}`)

  const body = (await res.json()) as {
    'Observation Time'?: unknown
    'Forecast Time'?: unknown
    coordinates?: unknown
  }

  const observed = isoToUnix(body['Observation Time'])
  const forecast = isoToUnix(body['Forecast Time'])
  if (observed === null || forecast === null) {
    throw new Error('SWPC aurora is missing Observation Time or Forecast Time')
  }
  if (!Array.isArray(body.coordinates)) {
    throw new Error('SWPC aurora returned no coordinates array')
  }

  const cells: AuroraCell[] = []
  let rejected = 0

  for (const raw of body.coordinates) {
    if (!Array.isArray(raw) || raw.length < 3) {
      rejected++
      continue
    }
    const [lonRaw, lat, probability] = raw as [number, number, number]
    if (
      typeof lonRaw !== 'number' ||
      typeof lat !== 'number' ||
      typeof probability !== 'number'
    ) {
      rejected++
      continue
    }
    if (probability < MIN_PROBABILITY) continue

    // SWPC publishes longitude as 0..359. Everything downstream — the Morton
    // index, the haversine refinement, the shader — assumes -180..180.
    cells.push({ lat, lon: lonRaw > 180 ? lonRaw - 360 : lonRaw, probability })
  }

  return { cells, observedUnix: observed, forecastUnix: forecast, rejected }
}

export interface AuroraAttrs {
  position: number
  probability: number
}

export function buildAuroraBatches(
  fetched: AuroraFetch,
  registry: EntityRegistry,
  attrs: AuroraAttrs,
): Batch[] {
  const validFrom = toTimestamp(fetched.forecastUnix)
  const validTo = toTimestamp(fetched.forecastUnix + FORECAST_VALID_SECONDS)

  return bucketBatches(
    fetched.cells,
    // System time is the OBSERVATION, not the forecast. Getting these the wrong
    // way round is what would turn a genuine above-diagonal source into another
    // point on the diagonal.
    () => fetched.observedUnix,
    (c, push) => {
      // The grid cell is the entity. A cell re-forecast an hour later is the
      // same place with a revised belief, which is exactly what the system axis
      // is for.
      const entity = registry.idFor(`swpc:aurora:${c.lat}:${c.lon}`)

      push({
        entity,
        attr: attrs.position,
        kind: Kind.Geo,
        validFrom,
        validTo,
        source: SOURCES.swpc!.id,
        writePayload: (v, off) => writeGeo(v, off, c.lat, c.lon),
      })
      push({
        entity,
        attr: attrs.probability,
        kind: Kind.F64,
        validFrom,
        validTo,
        source: SOURCES.swpc!.id,
        writePayload: (v, off) => writeF64Bits(v, off, c.probability),
      })
    },
  )
}

// ── source spec ─────────────────────────────────────────────────────────────

export const swpcSpec: SourceSpec<AuroraFetch> = {
  id: SOURCES.swpc!.id,
  key: 'swpc',
  label: 'aurora · swpc',
  layer: 'aurora',
  coverageNote: `forecast ~80 min ahead, ≥${MIN_PROBABILITY}% only`,
  // OVATION publishes a new grid every five minutes; asking more often returns
  // the same forecast, which the duplicate guard would drop anyway.
  pollSeconds: 300,
  attributes: [
    { name: 'aurora_position', sensitivity: Sensitivity.Public },
    { name: 'aurora_probability', sensitivity: Sensitivity.Public },
  ],
  fetch: (signal) => fetchAurora(SWPC_AURORA_URL, signal),
  normalize(raw, ctx) {
    return {
      batches: buildAuroraBatches(raw, ctx.registry, {
        position: ctx.attrs.aurora_position!,
        probability: ctx.attrs.aurora_probability!,
      }),
      count: raw.cells.length,
    }
  },
}
