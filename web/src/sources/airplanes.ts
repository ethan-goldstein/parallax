// ── web/src/sources/airplanes.ts ────────────────────────────────────────────
// airplanes.live — military ADS-B, global.
//
//   https://api.airplanes.live/v2/mil
//   Community-run aggregator of volunteer ADS-B receivers. Keyless, CORS-open.
//   Informal terms, non-commercial — see SOURCES.airplanes_live.
//
// This closes a loop the registry left open: `airplanes_live` has been reserved
// as source id 2 since Phase 4 and never fetched.
//
// ── why the military endpoint and not everything ───────────────────────────
//
// Partly practical: there is no global "all aircraft" endpoint, only radius
// queries, so worldwide civil coverage would mean dozens of requests per refresh
// against a volunteer-funded service. `/v2/mil` is one request for the whole
// planet.
//
// Mostly editorial. This is the layer where an OSINT dashboard is most tempted
// to overreach, so the boundary is worth stating: aircraft are rendered by
// ICAO hex, callsign and type, all of which the aircraft itself broadcasts in
// the clear. There is no registration lookup, no owner resolution, and no
// linking to an operator or a person. "Where is this open-data aircraft" is a
// question about a machine; "whose aircraft is this and where has it been" is
// a question about a person, and the README's refusal to track named
// individuals covers the second one.
//
// ── system time ────────────────────────────────────────────────────────────
//
// A position report has one timestamp. There is no separate "revised at", so
// like AIS these facts sit on the scrubber's diagonal: `seen_pos` seconds ago is
// both when it was true and when we learned it.
// ────────────────────────────────────────────────────────────────────────────
import { Kind, OPEN_VALID, toTimestamp, writeF64Bits, writeGeo, writeSymBits } from '../engine/abi'
import { bucketBatches, type Batch, type EntityRegistry } from './batch'
import { SOURCES } from './registry'
import { Sensitivity, type SourceSpec, type Viewport } from './spec'

export const AIRPLANES_MIL_URL = 'https://api.airplanes.live/v2/mil'

export interface Aircraft {
  /** ICAO 24-bit address, as broadcast. */
  hex: string
  lat: number
  lon: number
  /** Barometric altitude in feet. `ground` is reported as 0. */
  altitudeFt: number
  callsign: string
  type: string
  /** When the position was observed — both axes, see header. */
  timeUnix: number
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export async function fetchMilitaryAircraft(
  url: string = AIRPLANES_MIL_URL,
  signal?: AbortSignal,
): Promise<{ aircraft: Aircraft[]; rejected: number }> {
  const res = await fetch(url, signal ? { signal } : {})
  if (!res.ok) throw new Error(`airplanes.live returned ${res.status} ${res.statusText}`)

  const body = (await res.json()) as { ac?: unknown; now?: unknown }
  if (!Array.isArray(body.ac)) throw new Error('airplanes.live returned no ac array')

  // `now` is milliseconds on this feed.
  const nowMs = num(body.now)
  const nowUnix = nowMs !== null ? Math.floor(nowMs / 1000) : Math.floor(Date.now() / 1000)

  const aircraft: Aircraft[] = []
  let rejected = 0

  for (const raw of body.ac) {
    const a = raw as Record<string, unknown>
    const lat = num(a['lat'])
    const lon = num(a['lon'])
    const hex = typeof a['hex'] === 'string' ? a['hex'] : null

    // Roughly a quarter of the feed is aircraft heard by other means with no
    // position fix. They are not errors, they are simply not mappable.
    if (lat === null || lon === null || hex === null) {
      rejected++
      continue
    }

    // alt_baro is a number in feet, or the string "ground".
    const altRaw = a['alt_baro']
    const altitudeFt = altRaw === 'ground' ? 0 : (num(altRaw) ?? 0)

    // Seconds since this position was last seen, so the report time is now
    // minus that — not `now`, which would claim a stale contact is current.
    const seenPos = num(a['seen_pos']) ?? 0

    aircraft.push({
      hex,
      lat,
      lon,
      altitudeFt,
      callsign: typeof a['flight'] === 'string' ? a['flight'].trim() : '',
      type: typeof a['t'] === 'string' ? a['t'] : '',
      timeUnix: nowUnix - Math.round(seenPos),
    })
  }

  return { aircraft, rejected }
}

export interface AircraftAttrs {
  position: number
  altitude: number
  label: number
}

export function buildAircraftBatches(
  aircraft: readonly Aircraft[],
  registry: EntityRegistry,
  attrs: AircraftAttrs,
  intern: (text: string) => number,
): Batch[] {
  return bucketBatches(
    aircraft,
    (a) => a.timeUnix,
    (a, push) => {
      const entity = registry.idFor(`icao:${a.hex}`)
      const validFrom = toTimestamp(a.timeUnix)

      push({
        entity,
        attr: attrs.position,
        kind: Kind.Geo,
        validFrom,
        validTo: OPEN_VALID,
        source: SOURCES.airplanes_live!.id,
        writePayload: (v, off) => writeGeo(v, off, a.lat, a.lon),
      })
      push({
        entity,
        attr: attrs.altitude,
        kind: Kind.F64,
        validFrom,
        validTo: OPEN_VALID,
        source: SOURCES.airplanes_live!.id,
        writePayload: (v, off) => writeF64Bits(v, off, a.altitudeFt),
      })

      // Callsign and type ONLY, both broadcast in the clear by the aircraft
      // itself. This is the layer where the temptation to overreach lives, so
      // the boundary is worth restating where the code is: the label is what the
      // transponder says, never what a registry lookup would add. No tail-number
      // resolution, no operator, no owner. "Where is this open-data aircraft" is
      // a question about a machine; joining it to a person is a different
      // question and this project declines it.
      const label = [a.callsign, a.type].filter((x) => x.length > 0).join(' · ')
      if (label.length > 0) {
        const sym = intern(label)
        push({
          entity,
          attr: attrs.label,
          kind: Kind.Sym,
          validFrom,
          validTo: OPEN_VALID,
          source: SOURCES.airplanes_live!.id,
          writePayload: (v, off) => writeSymBits(v, off, sym),
        })
      }
    },
  )
}

// ── source spec ─────────────────────────────────────────────────────────────

export const airplanesSpec: SourceSpec<{ aircraft: Aircraft[]; rejected: number }> = {
  id: SOURCES.airplanes_live!.id,
  key: 'airplanes_live',
  label: 'military air · adsb',
  layer: 'aviation',
  coverageNote: 'self-declared military ADS-B only, no civil traffic',
  // Twenty seconds. An aircraft at 450 kn covers about 4 km in that time, so a
  // slower cadence would draw it somewhere it demonstrably is not — and a faster
  // one would take more from a volunteer-funded endpoint than the map can show.
  pollSeconds: 20,
  attributes: [
    // Precise, for the same reason a vessel position is: this locates one
    // identifiable asset, where an earthquake epicentre locates an event.
    { name: 'aircraft_position', sensitivity: Sensitivity.Precise },
    { name: 'altitude', sensitivity: Sensitivity.Public },
    // Public: a callsign is broadcast unencrypted by the aircraft. It is not a
    // person, and nothing here resolves it to one.
    { name: 'aircraft_label', sensitivity: Sensitivity.Public },
  ],
  fetch: (signal) => fetchMilitaryAircraft(AIRPLANES_MIL_URL, signal),
  normalize(raw, ctx) {
    return {
      batches: buildAircraftBatches(
        raw.aircraft,
        ctx.registry,
        {
          position: ctx.attrs.aircraft_position!,
          altitude: ctx.attrs.altitude!,
          label: ctx.attrs.aircraft_label!,
        },
        ctx.intern,
      ),
      count: raw.aircraft.length,
    }
  },
}

// ── civil traffic, scoped to the viewport ───────────────────────────────────
//
// The military feed above is a global list of a few hundred aircraft, which is
// small enough to ask for in one go. Civil traffic is not: there are tens of
// thousands airborne at any moment, and airplanes.live is volunteer-funded.
// Asking for all of it every twenty seconds would be both useless — the map
// cannot show it — and rude.
//
// So this one asks about the region on screen, and only when the region is small
// enough for the answer to mean something. Below zoom 4 the viewport is most of a
// hemisphere and the request is skipped, with the reason stated in the layer
// panel rather than silently returning nothing: a layer that is empty because
// you are zoomed out looks identical to a layer that is broken.
//
// It reuses SOURCES.airplanes_live: same provider, same terms, same courtesy
// obligations. The inspector attributing both layers to airplanes.live is true.
// ────────────────────────────────────────────────────────────────────────────

/** Below this the viewport is too large for a point query to be meaningful. */
const CIVIL_MIN_ZOOM = 4

/** airplanes.live caps a point query at 250 nm. Asking for more is an error. */
const CIVIL_MAX_RADIUS_NM = 250

export async function fetchCivilAircraft(
  view: Viewport,
  signal?: AbortSignal,
): Promise<{ aircraft: Aircraft[]; rejected: number; skipped: string | null }> {
  if (view.zoom < CIVIL_MIN_ZOOM) {
    return { aircraft: [], rejected: 0, skipped: 'zoomed out — civil traffic is viewport-scoped' }
  }
  const radiusNm = Math.min(CIVIL_MAX_RADIUS_NM, Math.max(1, Math.round(view.radiusKm / 1.852)))
  const url =
    `https://api.airplanes.live/v2/point/` +
    `${view.centerLat.toFixed(3)}/${view.centerLon.toFixed(3)}/${radiusNm}`

  const { aircraft, rejected } = await fetchMilitaryAircraft(url, signal)
  return { aircraft, rejected, skipped: null }
}

export const civilAircraftSpec: SourceSpec<{
  aircraft: Aircraft[]
  rejected: number
  skipped: string | null
}> = {
  id: SOURCES.airplanes_live!.id,
  key: 'airplanes_civil',
  label: 'civil air · adsb',
  layer: 'civil',
  viewport: 'required',
  coverageNote: `only what is on screen, and only above zoom ${CIVIL_MIN_ZOOM} — pan or zoom in to load more`,
  pollSeconds: 20,
  attributes: [
    // Distinct attribute NAMES, identical SENSITIVITIES.
    //
    // The first draft reused `aircraft_position` outright, on the argument that
    // the policy engine must treat civil and military traffic identically. The
    // classification argument is right and is kept — position is Precise here
    // exactly as it is there, and a weaker classification for civil traffic
    // would be indefensible. But sharing the name made the two indistinguishable
    // to the engine: a layer is defined by its geometry attribute, so both
    // layers queried the same attribute and rendered the same 198 aircraft.
    { name: 'civil_position', sensitivity: Sensitivity.Precise },
    { name: 'civil_altitude', sensitivity: Sensitivity.Public },
    { name: 'civil_label', sensitivity: Sensitivity.Public },
  ],
  fetch: (signal, view) => {
    if (!view) throw new Error('civil aircraft needs a viewport')
    return fetchCivilAircraft(view, signal)
  },
  normalize(raw, ctx) {
    if (raw.skipped !== null) throw new Error(raw.skipped)
    return {
      batches: buildAircraftBatches(
        raw.aircraft,
        ctx.registry,
        {
          position: ctx.attrs.civil_position!,
          altitude: ctx.attrs.civil_altitude!,
          label: ctx.attrs.civil_label!,
        },
        ctx.intern,
      ),
      count: raw.aircraft.length,
    }
  },
}
