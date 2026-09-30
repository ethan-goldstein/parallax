// ── web/src/sources/satellites.ts ───────────────────────────────────────────
// Orbital positions, propagated in the browser from CelesTrak element sets.
//
// ── this source does not observe anything ───────────────────────────────────
//
// Every other feed here reports something that was measured. This one reports
// something that was CALCULATED: a TLE is a set of orbital elements fitted to
// past observations, and SGP4 turns it into a position at an arbitrary instant.
// Nobody watched the satellite be there.
//
// That difference is modelled rather than disclaimed:
//
//   system time = the TLE EPOCH   — when the element set was determined
//   valid time  = the propagation instant — the moment being described
//
// Because the epoch is always earlier than the instant we propagate to, these
// facts land ABOVE the scrubber's diagonal, in the region the axis itself labels
// KNOWN BEFORE IT HAPPENED. A viewer sees that satellites are predictions in the
// same glance that shows them where the predictions are, without reading a word.
// The aurora forecast already lives up there for exactly this reason (see
// swpc.ts), so this is the established idiom rather than a new one.
//
// ── and validTo is bounded ──────────────────────────────────────────────────
//
// A propagated position is good for about as long as the object takes to move
// perceptibly, which in low Earth orbit is seconds. Leaving validTo open would
// assert that a satellite is at this point forever — the overclaim swpc.ts
// refuses for a forecast, and a worse one here because the object is moving at
// 7.6 km/s.
//
// ── on taking a dependency ──────────────────────────────────────────────────
//
// SGP4 is a specification-defined numerical model with published test vectors.
// A hand-rolled version would be a liability rather than a demonstration: the
// thing being demonstrated in this repository is the bitemporal engine, and an
// orbital propagator subtly wrong in the fourth decimal place would undermine
// that rather than add to it. satellite.js is ~40 KB and MIT.
// ────────────────────────────────────────────────────────────────────────────
import {
  eciToGeodetic,
  gstime,
  propagate,
  twoline2satrec,
  type SatRec,
} from 'satellite.js'

import { Kind, toTimestamp, writeF64Bits, writeGeo, writeSymBits } from '../engine/abi'
import { bucketBatches, type Batch, type EntityRegistry } from './batch'
import { SOURCES } from './registry'
import { Sensitivity, type SourceSpec } from './spec'

const CT = 'https://celestrak.org/NORAD/elements/gp.php?FORMAT=tle&GROUP='

/**
 * The same four groups, as a same-origin snapshot written by
 * `npm run build:tle` and refreshed by the daily Pages deploy.
 *
 * ── why the snapshot comes first ──────────────────────────────────────────
 *
 * This source fetched CelesTrak live from every visitor's browser, four
 * requests per page load. CelesTrak asks for no more than one fetch per group
 * every two hours and blocks addresses that ignore it, and element sets are
 * only re-determined a few times a day, so the live fetch was costing a
 * one-person site goodwill to buy nothing a daily snapshot does not provide.
 *
 * Bitemporally it is a wash: system time is the TLE EPOCH, read from the
 * element set, not the moment anything was fetched. Live or snapshot, the same
 * epoch lands in the same place on the axis. The panel says which one it was
 * and when the snapshot was taken, because that is the one thing a viewer
 * cannot read off the axis.
 *
 * The live path survives as the fallback for a build with no snapshot in it,
 * which is a fresh clone that has not run the script.
 */
const SNAPSHOT_DIR = 'tle/'

/**
 * A demonstration set, not a catalogue.
 *
 * Four groups, roughly five hundred objects. The full catalogue is over thirty
 * thousand, which would take minutes to fetch, seconds to propagate, and would
 * render as a solid shell — impressive for one screenshot and useless as an
 * instrument. Stations and the navigation constellations are the objects a
 * viewer can actually recognise.
 *
 * Must match GROUPS in scripts/fetch-tle.mjs.
 */
const GROUPS = ['stations', 'gps-ops', 'science', 'visual'] as const

/** How long a propagated position is asserted to be true, in seconds each way. */
const VALID_HALF_WINDOW = 150

export interface SatelliteRecord {
  name: string
  satrec: SatRec
  /** TLE epoch as unix seconds — when this element set was determined. */
  epochUnix: number
}

export interface SatelliteFetch {
  sats: SatelliteRecord[]
  /** TLE lines that would not parse. Reported, never silently skipped. */
  rejected: number
  /** Where the element sets came from: the build's snapshot, or CelesTrak live. */
  origin: { kind: 'snapshot'; fetchedAt: string; partial: boolean } | { kind: 'live' }
}

interface SnapshotManifest {
  fetchedAt: string
  partial?: boolean
  groups: Record<string, { records: number }>
}

/**
 * The snapshot's manifest, or null when this build has none.
 *
 * A 404 is the expected answer on a fresh clone and is not an error; anything
 * else that goes wrong reading the manifest is treated the same way, because
 * the live fetch is a complete fallback and there is nothing to gain from
 * failing the layer over a broken manifest.
 */
async function loadManifest(signal?: AbortSignal): Promise<SnapshotManifest | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}${SNAPSHOT_DIR}manifest.json`, {
      ...(signal ? { signal } : {}),
      cache: 'no-cache',
    })
    if (!res.ok) return null
    const m = (await res.json()) as Partial<SnapshotManifest>
    if (typeof m.fetchedAt !== 'string' || typeof m.groups !== 'object' || !m.groups) return null
    return m as SnapshotManifest
  } catch {
    return null
  }
}

/**
 * Element-set epoch, in unix seconds.
 *
 * satellite.js exposes the epoch as a year plus a fractional day-of-year, which
 * is the TLE's own encoding. Two-digit years follow the TLE convention: 57–99
 * mean 19xx, 00–56 mean 20xx.
 */
function epochUnixOf(satrec: SatRec): number {
  const yy = satrec.epochyr
  const year = yy < 57 ? 2000 + yy : 1900 + yy
  const jan1 = Date.UTC(year, 0, 1) / 1000
  return jan1 + (satrec.epochdays - 1) * 86400
}

export async function fetchSatellites(signal?: AbortSignal): Promise<SatelliteFetch> {
  const manifest = await loadManifest(signal)

  // Only the groups the manifest says exist. A group the snapshot is missing
  // is not fetched live to fill the gap: mixing one live group into a dated
  // snapshot would make "fetched at" untrue for part of the layer.
  const groups = manifest ? GROUPS.filter((g) => g in manifest.groups) : GROUPS
  const base = manifest ? `${import.meta.env.BASE_URL}${SNAPSHOT_DIR}` : CT
  const suffix = manifest ? '.txt' : ''

  const texts = await Promise.all(
    groups.map(async (g) => {
      const res = await fetch(`${base}${g}${suffix}`, signal ? { signal } : {})
      if (!res.ok) throw new Error(`${manifest ? 'snapshot' : 'celestrak'} ${g} ${res.status}`)
      return res.text()
    }),
  )

  const origin: SatelliteFetch['origin'] = manifest
    ? { kind: 'snapshot', fetchedAt: manifest.fetchedAt, partial: manifest.partial === true }
    : { kind: 'live' }

  const sats: SatelliteRecord[] = []
  const seen = new Set<string>()
  let rejected = 0

  for (const text of texts) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
    for (let i = 0; i + 2 < lines.length + 1; i += 3) {
      const name = lines[i]?.trim()
      const l1 = lines[i + 1]
      const l2 = lines[i + 2]
      if (!name || !l1?.startsWith('1 ') || !l2?.startsWith('2 ')) {
        rejected++
        continue
      }
      // The groups overlap — the ISS is in both `stations` and `visual` — and a
      // duplicate would be two entities at one position rather than one object.
      const noradId = l1.slice(2, 7).trim()
      if (seen.has(noradId)) continue

      try {
        const satrec = twoline2satrec(l1, l2)
        // satellite.js signals a bad element set through `error`, not a throw.
        if (satrec.error !== 0) {
          rejected++
          continue
        }
        seen.add(noradId)
        sats.push({ name, satrec, epochUnix: epochUnixOf(satrec) })
      } catch {
        rejected++
      }
    }
  }

  return { sats, rejected, origin }
}

/**
 * The coverage note, with where the element sets came from and when.
 *
 * `2026-09-30 03:17Z`, not a relative "14 hours ago": a relative age is only
 * true at the instant it was rendered, and this note is written once per fetch
 * and read for the next six hours.
 */
function originNote(origin: SatelliteFetch['origin']): string {
  const stem = 'positions are PROPAGATED from element sets, not observed — they sit above the scrubber diagonal for that reason'
  if (origin.kind === 'live') return `${stem} · element sets fetched live from CelesTrak`
  const at = origin.fetchedAt.replace('T', ' ').replace(/:\d\d(\.\d+)?(Z|[+-]\d\d:?\d\d)$/, 'Z')
  return `${stem} · element-set snapshot ${at}${origin.partial ? ' (some groups older)' : ''}`
}

interface SatelliteAttrs {
  position: number
  altitude: number
  label: number
}

const DEG = 180 / Math.PI

export function buildSatelliteBatches(
  sats: readonly SatelliteRecord[],
  registry: EntityRegistry,
  attrs: SatelliteAttrs,
  intern: (text: string) => number,
  atUnix: number,
): Batch[] {
  const at = new Date(atUnix * 1000)
  const gmst = gstime(at)

  // Propagated first, then bucketed by EPOCH — so objects whose element sets
  // were determined at the same time share a transaction, and the system axis
  // reflects when the tracking network published rather than when this page ran.
  const positioned = sats
    .map((s) => {
      let lat: number
      let lon: number
      let altKm: number
      try {
        const pv = propagate(s.satrec, at)
        if (!pv?.position || typeof pv.position === 'boolean') return null
        const geo = eciToGeodetic(pv.position, gmst)
        lat = geo.latitude * DEG
        lon = geo.longitude * DEG
        altKm = geo.height
      } catch {
        return null
      }
      // A decayed or numerically diverged object produces nonsense rather than
      // an error. Dropped, never plotted: a satellite at the centre of the Earth
      // is not a data point.
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(altKm)) return null
      if (altKm < 80 || altKm > 60_000) return null
      // eciToGeodetic returns longitude in (-2π, 2π); normalise to (-180, 180].
      while (lon > 180) lon -= 360
      while (lon < -180) lon += 360
      return { s, lat, lon, altKm }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  return bucketBatches(
    positioned,
    (p) => p.s.epochUnix,
    (p, push) => {
      const entity = registry.idFor(`sat:${p.s.satrec.satnum}`)
      // The window the propagated position is asserted over — a few minutes,
      // centred on the instant asked for.
      const validFrom = toTimestamp(atUnix - VALID_HALF_WINDOW)
      const validTo = toTimestamp(atUnix + VALID_HALF_WINDOW)

      push({
        entity,
        attr: attrs.position,
        kind: Kind.Geo,
        validFrom,
        validTo,
        source: SOURCES.celestrak!.id,
        writePayload: (v, off) => writeGeo(v, off, p.lat, p.lon),
      })
      push({
        entity,
        attr: attrs.altitude,
        kind: Kind.F64,
        validFrom,
        validTo,
        source: SOURCES.celestrak!.id,
        writePayload: (v, off) => writeF64Bits(v, off, p.altKm),
      })
      const sym = intern(p.s.name)
      push({
        entity,
        attr: attrs.label,
        kind: Kind.Sym,
        validFrom,
        validTo,
        source: SOURCES.celestrak!.id,
        writePayload: (v, off) => writeSymBits(v, off, sym),
      })
    },
  )
}

export const satellitesSpec: SourceSpec<SatelliteFetch> = {
  id: SOURCES.celestrak!.id,
  key: 'celestrak',
  label: 'satellites · celestrak',
  layer: 'satellites',
  coverageNote:
    'positions are PROPAGATED from element sets, not observed — they sit above the scrubber diagonal for that reason',
  derivation: {
    method: 'SGP4',
    note: 'orbital elements propagated to the requested instant; nothing here was measured',
  },
  // Element sets are re-determined a few times a day; refetching faster returns
  // the same TLEs, which the duplicate guard would drop anyway. Against the
  // snapshot this is a same-origin fetch and costs CelesTrak nothing.
  pollSeconds: 21_600,
  // Re-propagated from the cached element sets far more often than they are
  // refetched. This is the only kind of source for which recomputing is
  // legitimate — recomputing an observation would be inventing data.
  recomputeSeconds: 120,
  attributes: [
    { name: 'satellite_position', sensitivity: Sensitivity.Public },
    { name: 'satellite_altitude', sensitivity: Sensitivity.Public },
    { name: 'satellite_label', sensitivity: Sensitivity.Public },
  ],
  fetch: (signal) => fetchSatellites(signal),
  normalize(raw, ctx) {
    return {
      batches: buildSatelliteBatches(
        raw.sats,
        ctx.registry,
        {
          position: ctx.attrs.satellite_position!,
          altitude: ctx.attrs.satellite_altitude!,
          label: ctx.attrs.satellite_label!,
        },
        ctx.intern,
        Math.floor(Date.now() / 1000),
      ),
      count: raw.sats.length,
      note: originNote(raw.origin),
    }
  },
}
