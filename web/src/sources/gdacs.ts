// ── web/src/sources/gdacs.ts ────────────────────────────────────────────────
// GDACS — Global Disaster Alert and Coordination System (EC JRC / UN OCHA).
//
//   https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP
//   Keyless, CORS-open, public sector information.
//
// ── why this source earns its place ────────────────────────────────────────
//
// It is the only feed added in this pass that carries a real revision axis of
// its own. Each event has `fromdate` — when the disaster began — and
// `datemodified`, when GDACS last changed its assessment. Those are genuinely
// different instants: an earthquake observed at 02:07 was still being revised
// at 02:39.
//
// That is the same shape as USGS/EMSC and for the same reason: the alert LEVEL
// is a judgement that gets revised as impact estimates firm up. A Green alert
// upgraded to Orange six hours later is two different operational pictures, and
// only one of them was actionable at the time. Scrub the system axis back and
// the alert reverts to what it was rated then.
//
// Alert level is the scalar rather than the raw severity number, because
// severity means something different per hazard type — 4.6 is a magnitude for
// an earthquake and a wind speed for a cyclone. The alert level is the one field
// GDACS defines consistently across all of them.
// ────────────────────────────────────────────────────────────────────────────
import { Kind, OPEN_VALID, toTimestamp, writeF64Bits, writeGeo, writeSymBits } from '../engine/abi'
import { bucketBatches, type Batch, type EntityRegistry } from './batch'
import { SOURCES } from './registry'
import { Sensitivity, type SourceSpec } from './spec'

export const GDACS_URL =
  'https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP'

/** Green / Orange / Red, mapped so the colour ramp has a comparable axis. */
const ALERT_LEVEL: Record<string, number> = { Green: 0, Orange: 1, Red: 2 }

export interface GdacsEvent {
  id: string
  lat: number
  lon: number
  /** 0 green, 1 orange, 2 red. */
  alert: number
  eventType: string
  name: string
  /** When the disaster began — valid time. */
  fromUnix: number
  /** When GDACS last revised the assessment — system time. */
  modifiedUnix: number
}

/**
 * GDACS timestamps have no timezone suffix and are UTC. `Date.parse` on a bare
 * `2026-07-31T02:07:56` is treated as LOCAL time by the spec, which would shift
 * every event by the viewer's offset and quietly tilt the whole system axis.
 */
function utcToUnix(v: unknown): number | null {
  if (typeof v !== 'string' || v.length === 0) return null
  const iso = /[Zz]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}Z`
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export async function fetchGdacs(
  url: string = GDACS_URL,
  signal?: AbortSignal,
): Promise<{ events: GdacsEvent[]; rejected: number }> {
  const res = await fetch(url, signal ? { signal } : {})
  if (!res.ok) throw new Error(`GDACS returned ${res.status} ${res.statusText}`)

  const body: unknown = await res.json()
  const features: unknown = (body as { features?: unknown })?.features
  if (!Array.isArray(features)) throw new Error('GDACS returned no features array')

  const events: GdacsEvent[] = []
  let rejected = 0

  for (const raw of features) {
    const f = raw as {
      properties?: Record<string, unknown>
      geometry?: { coordinates?: unknown }
    }
    const p = f.properties
    const coords = f.geometry?.coordinates

    if (!p || !Array.isArray(coords) || coords.length < 2) {
      rejected++
      continue
    }
    const lon = num(coords[0])
    const lat = num(coords[1])
    const from = utcToUnix(p['fromdate'])
    if (lat === null || lon === null || from === null) {
      rejected++
      continue
    }

    const eventId = String(p['eventid'] ?? '')
    const episode = String(p['episodeid'] ?? '')
    events.push({
      // Episode is part of the identity: GDACS re-issues an event as new
      // episodes as it develops, and collapsing them would merge distinct
      // assessments into one.
      id: `gdacs:${p['eventtype'] ?? '?'}:${eventId}:${episode}`,
      lat,
      lon,
      alert: ALERT_LEVEL[String(p['alertlevel'] ?? 'Green')] ?? 0,
      eventType: String(p['eventtype'] ?? '?'),
      // `??` is wrong here and was: GDACS sends eventname as an EMPTY STRING
      // for everything except named storms, and empty string is not nullish, so
      // it won the coalesce and the label came out blank for 98 of 100 events.
      // `name` is the descriptive one ("Earthquake in Japan"); `eventname` is
      // the storm designation ("GENEVIEVE-26"). Keep both when both exist.
      name: (() => {
        const storm = String(p['eventname'] ?? '').trim()
        const described = String(p['name'] ?? '').trim()
        if (storm && described) return `${described} (${storm})`
        return described || storm
      })(),
      fromUnix: from,
      // Falls back to fromdate when GDACS has not revised — which puts the fact
      // exactly on the diagonal, where it belongs, rather than inventing a
      // revision that did not happen.
      modifiedUnix: utcToUnix(p['datemodified']) ?? from,
    })
  }

  return { events, rejected }
}

export interface GdacsAttrs {
  position: number
  alert: number
  label: number
}

export function buildGdacsBatches(
  events: readonly GdacsEvent[],
  registry: EntityRegistry,
  attrs: GdacsAttrs,
  intern: (text: string) => number,
): Batch[] {
  return bucketBatches(
    events,
    (e) => e.modifiedUnix,
    (e, push) => {
      const entity = registry.idFor(e.id)
      const validFrom = toTimestamp(e.fromUnix)

      push({
        entity,
        attr: attrs.position,
        kind: Kind.Geo,
        validFrom,
        validTo: OPEN_VALID,
        source: SOURCES.gdacs!.id,
        writePayload: (v, off) => writeGeo(v, off, e.lat, e.lon),
      })
      push({
        entity,
        attr: attrs.alert,
        kind: Kind.F64,
        validFrom,
        validTo: OPEN_VALID,
        source: SOURCES.gdacs!.id,
        writePayload: (v, off) => writeF64Bits(v, off, e.alert),
      })

      // GDACS revises the assessment, and the name goes with it — an event
      // renamed as its location firms up is a revision worth being able to
      // scrub back through, which is exactly what storing it as a fact buys.
      if (e.name.length > 0) {
        const sym = intern(e.name)
        push({
          entity,
          attr: attrs.label,
          kind: Kind.Sym,
          validFrom,
          validTo: OPEN_VALID,
          source: SOURCES.gdacs!.id,
          writePayload: (v, off) => writeSymBits(v, off, sym),
        })
      }
    },
  )
}

// ── source spec ─────────────────────────────────────────────────────────────

export const gdacsSpec: SourceSpec<{ events: GdacsEvent[]; rejected: number }> = {
  id: SOURCES.gdacs!.id,
  key: 'gdacs',
  label: 'alerts · gdacs',
  layer: 'alerts',
  coverageNote: 'earthquake, flood, cyclone, wildfire, volcano, drought',
  attributes: [
    { name: 'alert_position', sensitivity: Sensitivity.Public },
    { name: 'alert_level', sensitivity: Sensitivity.Public },
    { name: 'alert_label', sensitivity: Sensitivity.Public },
  ],
  fetch: (signal) => fetchGdacs(GDACS_URL, signal),
  normalize(raw, ctx) {
    return {
      batches: buildGdacsBatches(
        raw.events,
        ctx.registry,
        {
          position: ctx.attrs.alert_position!,
          alert: ctx.attrs.alert_level!,
          label: ctx.attrs.alert_label!,
        },
        ctx.intern,
      ),
      count: raw.events.length,
    }
  },
}
