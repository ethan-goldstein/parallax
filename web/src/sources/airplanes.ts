// ── web/src/sources/airplanes.ts ────────────────────────────────────────────
// ADS-B, through the relay in relay/worker.js. Military globally, civil by
// viewport.
//
// ── why there is a relay ────────────────────────────────────────────────────
//
// This file used to read airplanes.live directly: keyless, CORS-open, one
// request for every self-declared military aircraft on the planet. In 2026
// airplanes.live withdrew anonymous access (the API now answers 403 and asks
// for an email), and every other community aggregator (adsb.fi, adsb.lol,
// adsb.one, OpenSky) serves JSON without an Access-Control-Allow-Origin
// header. Checked from the deployed origin, not assumed: all five fail in the
// browser. There is no keyless ADS-B feed a static page can read.
//
// The relay is the smallest honest answer: a stateless Cloudflare Worker that
// forwards two fixed paths to adsb.fi (adsb.lol as fallback) and adds the CORS
// header. It holds no key and stores nothing. The README says so plainly,
// because "no backend" was the project's opening claim and it is now true for
// every layer but this one.
//
// Its URL comes from VITE_ADSB_RELAY at build time. Without it this source
// does not fetch anything: it reports, in the layer panel, that no relay is
// configured and why one is needed. An empty sky that looks like a broken
// layer is the failure this project spends its layer panel arguing against.
//
// ── what the data is, and is not ────────────────────────────────────────────
//
// This is the layer where an OSINT dashboard is most tempted to overreach, so
// the boundary is worth stating: aircraft are rendered by ICAO hex, callsign
// and type, all of which the aircraft itself broadcasts in the clear. There is
// no registration lookup, no owner resolution, and no linking to an operator
// or a person. "Where is this open-data aircraft" is a question about a
// machine; "whose aircraft is this and where has it been" is a question about
// a person, and the README's refusal to track named individuals covers it.
//
// ── system time ─────────────────────────────────────────────────────────────
//
// A position report has one timestamp. There is no separate "revised at", so
// like AIS these facts sit on the scrubber's diagonal: `seen_pos` seconds ago
// is both when it was true and when we learned it.
// ────────────────────────────────────────────────────────────────────────────
import { Kind, toTimestamp, writeF64Bits, writeGeo, writeSymBits } from '../engine/abi'
import { bucketBatches, type Batch, type EntityRegistry } from './batch'
import { SOURCES } from './registry'
import { Sensitivity, type SourceSpec, type Viewport } from './spec'

/**
 * Base URL of the relay, or undefined when the build was made without one.
 *
 * Read once, at module load, from a build-time variable rather than from the
 * page: the relay's Origin allowlist is the deployed site, so a URL that could
 * be changed at runtime would only ever point at something that refuses us.
 */
export const ADSB_RELAY: string | undefined = (() => {
  const raw = (import.meta.env.VITE_ADSB_RELAY as string | undefined)?.trim()
  return raw ? raw.replace(/\/+$/, '') : undefined
})()

export const NO_RELAY =
  'no ADS-B relay in this build: airplanes.live withdrew keyless access in 2026 and no ' +
  'aggregator sends CORS headers, so a static page cannot read any of them (see relay/)'

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

export interface AircraftFetch {
  aircraft: Aircraft[]
  rejected: number
  /** Which aggregator the relay actually got its answer from, if it said. */
  upstream: string | null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * How long one position report is asserted to hold, in seconds.
 *
 * It used to be open-ended, which asserted that an aircraft seen at 14:00:00
 * was still there at 14:10 and would be there forever: every poll added a new
 * point beside the last, and after ten minutes each aircraft trailed thirty
 * stale copies of itself. Thirty seconds is one poll interval plus slack:
 * every instant is covered by the report that preceded it, at most two reports
 * overlap, and a report the feed has stopped renewing drops off the map rather
 * than sitting where the aircraft is not. Scrubbing the valid axis back now
 * shows where each aircraft WAS at that instant, which an open-ended interval
 * could not express. A missed poll blanks the layer for ten seconds, which is
 * the honest picture of a feed that did not answer.
 */
const REPORT_VALID_SECONDS = 30

/**
 * Fetches one relay path and parses the readsb / ADSBexchange v2 shape.
 *
 * adsb.fi and adsb.lol both speak it, as airplanes.live did, so the parser is
 * unchanged from the direct-fetch days: `ac[]` with `hex`, `lat`, `lon`,
 * `alt_baro`, `flight`, `t`, `seen_pos`, and a top-level `now` in milliseconds.
 */
export async function fetchAircraft(path: string, signal?: AbortSignal): Promise<AircraftFetch> {
  if (ADSB_RELAY === undefined) throw new Error(NO_RELAY)

  const res = await fetch(`${ADSB_RELAY}${path}`, signal ? { signal } : {})
  if (!res.ok) {
    // The relay reports an upstream failure as JSON with an `error`; surface
    // that text rather than "502", which says nothing about which side failed.
    let detail = `${res.status} ${res.statusText}`
    try {
      const body = (await res.json()) as { error?: unknown }
      if (typeof body.error === 'string') detail = body.error
    } catch {
      // Not JSON. The status line is all there is.
    }
    throw new Error(`relay: ${detail}`)
  }

  const body = (await res.json()) as { ac?: unknown; now?: unknown }
  if (!Array.isArray(body.ac)) throw new Error('relay returned no ac array')

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

  return { aircraft, rejected, upstream: res.headers.get('x-parallax-upstream') }
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
      const validTo = toTimestamp(a.timeUnix + REPORT_VALID_SECONDS)

      push({
        entity,
        attr: attrs.position,
        kind: Kind.Geo,
        validFrom,
        validTo,
        source: SOURCES.adsb_fi!.id,
        writePayload: (v, off) => writeGeo(v, off, a.lat, a.lon),
      })
      push({
        entity,
        attr: attrs.altitude,
        kind: Kind.F64,
        validFrom,
        validTo,
        source: SOURCES.adsb_fi!.id,
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
          validTo,
          source: SOURCES.adsb_fi!.id,
          writePayload: (v, off) => writeSymBits(v, off, sym),
        })
      }
    },
  )
}

/** A note naming the aggregator that answered, when the relay said which. */
function viaNote(base: string, upstream: string | null): string {
  return upstream ? `${base} · via ${upstream}` : base
}

// ── military, global ────────────────────────────────────────────────────────
//
// `/mil` is one request for every aircraft the aggregator flags as military,
// worldwide: a few hundred, small enough to ask for whole. The flag is the
// aggregator's own (a database of known military hex ranges), which is why the
// coverage note says "self-declared".

const MIL_NOTE = 'self-declared military ADS-B only, no civil traffic'

export const airplanesSpec: SourceSpec<AircraftFetch> = {
  id: SOURCES.adsb_fi!.id,
  key: 'adsb_mil',
  label: 'military air · adsb',
  layer: 'aviation',
  coverageNote: MIL_NOTE,
  // Twenty seconds. An aircraft at 450 kn covers about 4 km in that time, so a
  // slower cadence would draw it somewhere it demonstrably is not; a faster
  // one would take more from a volunteer-run endpoint than the map can show.
  // The relay caches for ten, so a hundred viewers cost the upstream the same
  // as one. With no relay there is nothing to poll: the layer fails once, at
  // boot, with the reason, rather than counting down to the same failure every
  // twenty seconds.
  ...(ADSB_RELAY !== undefined ? { pollSeconds: 20 } : {}),
  attributes: [
    // Precise, for the same reason a vessel position is: this locates one
    // identifiable asset, where an earthquake epicentre locates an event.
    { name: 'aircraft_position', sensitivity: Sensitivity.Precise },
    { name: 'altitude', sensitivity: Sensitivity.Public },
    // Public: a callsign is broadcast unencrypted by the aircraft. It is not a
    // person, and nothing here resolves it to one.
    // Identifying: a callsign picks out one airframe, which is precisely the
    // narrowing R1 exists to refuse under a purpose that does not permit it.
    { name: 'aircraft_label', sensitivity: Sensitivity.Public, identifying: true },
  ],
  fetch: (signal) => fetchAircraft('/mil', signal),
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
      note: viaNote(MIL_NOTE, raw.upstream),
    }
  },
}

// ── civil traffic, scoped to the viewport ───────────────────────────────────
//
// The military feed above is a global list of a few hundred aircraft, which is
// small enough to ask for in one go. Civil traffic is not: there are tens of
// thousands airborne at any moment, and the aggregators are volunteer-run.
// Asking for all of it every twenty seconds would be both useless, since the
// map cannot show it, and rude.
//
// So this one asks about the region on screen, and only when the region is small
// enough for the answer to mean something. Below zoom 4 the viewport is most of a
// hemisphere and the request is skipped, with the reason stated in the layer
// panel rather than silently returning nothing: a layer that is empty because
// you are zoomed out looks identical to a layer that is broken.
//
// It reuses SOURCES.adsb_fi: same provider, same terms, same courtesy
// obligations. The inspector attributing both layers to adsb.fi is true.
// ────────────────────────────────────────────────────────────────────────────

/** Below this the viewport is too large for a point query to be meaningful. */
const CIVIL_MIN_ZOOM = 4

/** The upstreams cap a point query at 250 nm. Asking for more is an error. */
const CIVIL_MAX_RADIUS_NM = 250

const CIVIL_NOTE = `only what is on screen, and only above zoom ${CIVIL_MIN_ZOOM} — pan or zoom in to load more`

export async function fetchCivilAircraft(
  view: Viewport,
  signal?: AbortSignal,
): Promise<AircraftFetch & { skipped: string | null }> {
  if (ADSB_RELAY === undefined) throw new Error(NO_RELAY)
  if (view.zoom < CIVIL_MIN_ZOOM) {
    return {
      aircraft: [],
      rejected: 0,
      upstream: null,
      skipped: 'zoomed out — civil traffic is viewport-scoped',
    }
  }
  const radiusNm = Math.min(CIVIL_MAX_RADIUS_NM, Math.max(1, Math.round(view.radiusKm / 1.852)))
  const path = `/point/${view.centerLat.toFixed(3)}/${view.centerLon.toFixed(3)}/${radiusNm}`
  const got = await fetchAircraft(path, signal)
  return { ...got, skipped: null }
}

export const civilAircraftSpec: SourceSpec<AircraftFetch & { skipped: string | null }> = {
  id: SOURCES.adsb_fi!.id,
  key: 'adsb_civil',
  label: 'civil air · adsb',
  layer: 'civil',
  viewport: 'required',
  coverageNote: CIVIL_NOTE,
  ...(ADSB_RELAY !== undefined ? { pollSeconds: 20 } : {}),
  attributes: [
    // Distinct attribute NAMES, identical SENSITIVITIES.
    //
    // The first draft reused `aircraft_position` outright, on the argument that
    // the policy engine must treat civil and military traffic identically. The
    // classification argument is right and is kept: position is Precise here
    // exactly as it is there, and a weaker classification for civil traffic
    // would be indefensible. But sharing the name made the two indistinguishable
    // to the engine: a layer is defined by its geometry attribute, so both
    // layers queried the same attribute and rendered the same 198 aircraft.
    { name: 'civil_position', sensitivity: Sensitivity.Precise },
    { name: 'civil_altitude', sensitivity: Sensitivity.Public },
    { name: 'civil_label', sensitivity: Sensitivity.Public, identifying: true },
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
      note: viaNote(CIVIL_NOTE, raw.upstream),
    }
  },
}
