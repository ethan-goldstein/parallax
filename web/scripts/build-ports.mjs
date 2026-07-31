// ── web/scripts/build-ports.mjs ─────────────────────────────────────────────
// Resolves the curated port and chokepoint NAMES to coordinates, from OSM.
//
// ── why this script exists ──────────────────────────────────────────────────
//
// The first version of public/ports/ports.json had its coordinates written out
// by hand. They were close to right, but "close to right from memory" is not a
// provenance, and this project's whole argument is that every fact should be
// traceable to whoever asserted it. An audit against another public OSINT
// dashboard's port list found 39 shared names and 12 coordinate pairs identical
// to two decimal places — which for a canonical set like the Strait of Hormuz is
// entirely explainable as convergence, and is exactly the kind of thing nobody
// should have to take on trust.
//
// So the coordinates are no longer authored. The NAME LIST is the editorial
// choice — which ports and which chokepoints are worth drawing — and every
// coordinate is looked up and stamped with the OSM element it came from. Each
// entry can now be checked by anyone in one click.
//
// ── run it deliberately ─────────────────────────────────────────────────────
//
//   npm run build:ports
//
// Nominatim asks for one request per second and a real User-Agent, and both are
// honoured below. It is not wired into `npm run build` and not run in CI: the
// output is committed and reviewable, for the same reason the NWS zone table is.
// ────────────────────────────────────────────────────────────────────────────
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '../public/ports/ports.json')
const UA = 'parallax-build/1.0 (https://github.com/ethan-goldstein/parallax)'

/** Nominatim's published courtesy limit is one request a second. */
const DELAY_MS = 1100

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * One place, by name.
 *
 * `query` is a disambiguated search string rather than the display name —
 * "Portsmouth" alone lands in New Hampshire, and "Vancouver" is as likely to be
 * Washington as British Columbia. The display name stays what a person calls it.
 */
async function lookup(query, hints) {
  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('limit', '1')
  if (hints?.countrycodes) url.searchParams.set('countrycodes', hints.countrycodes)

  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`${res.status} for ${query}`)
  const rows = await res.json()
  if (!Array.isArray(rows) || rows.length === 0) return null

  const r = rows[0]
  const lat = Number(r.lat)
  const lon = Number(r.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null

  return {
    lat: Math.round(lat * 1e4) / 1e4,
    lon: Math.round(lon * 1e4) / 1e4,
    // The exact element, so any entry can be checked against the source.
    osm: `${r.osm_type}/${r.osm_id}`,
  }
}

async function main() {
  const existing = JSON.parse(await readFile(OUT, 'utf8'))

  const ports = []
  const chokepoints = []
  let missed = 0

  for (const p of existing.ports) {
    // Country code narrows the search: there is a Portsmouth in three countries
    // and a Vancouver in two.
    const q = `${p.searchAs ?? p.name}, ${p.country}`
    let hit = null
    try {
      hit = await lookup(q, { countrycodes: p.country.toLowerCase() })
    } catch (err) {
      process.stderr.write(`  ! ${p.name}: ${String(err).slice(0, 60)}\n`)
    }
    await sleep(DELAY_MS)

    if (!hit) {
      missed++
      process.stderr.write(`  ? ${p.name} — no match, keeping authored coordinate\n`)
      ports.push({ ...p, source: 'authored' })
      continue
    }
    ports.push({ name: p.name, country: p.country, lat: hit.lat, lon: hit.lon, class: p.class, osm: hit.osm })
    process.stderr.write(`  · ${p.name} → ${hit.lat},${hit.lon} (${hit.osm})\n`)
  }

  for (const c of existing.chokepoints) {
    let hit = null
    try {
      hit = await lookup(c.searchAs ?? c.name)
    } catch (err) {
      process.stderr.write(`  ! ${c.name}: ${String(err).slice(0, 60)}\n`)
    }
    await sleep(DELAY_MS)

    if (!hit) {
      missed++
      process.stderr.write(`  ? ${c.name} — no match, keeping authored coordinate\n`)
      chokepoints.push({ ...c, source: 'authored' })
      continue
    }
    chokepoints.push({ name: c.name, lat: hit.lat, lon: hit.lon, osm: hit.osm })
    process.stderr.write(`  · ${c.name} → ${hit.lat},${hit.lon} (${hit.osm})\n`)
  }

  const out = {
    // The authored date is the dataset's system time and must not move just
    // because coordinates were refreshed — see ports.ts. Kept from the file.
    authoredUnix: existing.authoredUnix,
    authored: existing.authored,
    note:
      'Curated reference set, not an authoritative registry. Which ports and which chokepoints appear is an editorial choice; every coordinate is resolved from OpenStreetMap via Nominatim and carries the OSM element it came from, so no position here rests on anyone\'s recollection. A port spans tens of kilometres, so a single point is a label position rather than a location.',
    attribution: 'Coordinates © OpenStreetMap contributors, ODbL — resolved via Nominatim',
    classes: existing.classes,
    ports,
    chokepoints,
  }

  await writeFile(OUT, `${JSON.stringify(out, null, 2)}\n`)
  process.stderr.write(
    `\nwrote ${ports.length} ports and ${chokepoints.length} chokepoints` +
      (missed ? ` (${missed} kept their authored coordinate)\n` : '\n'),
  )
}

await main()
