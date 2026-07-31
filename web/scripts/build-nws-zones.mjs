// ── web/scripts/build-nws-zones.mjs ─────────────────────────────────────────
// Precomputes a zone-code → centroid table for the NWS weather-alert layer.
//
// ── why this exists ─────────────────────────────────────────────────────────
//
// Most active NWS alerts carry no geometry. Measured on a live pull: 26 of 176
// features had a polygon; the other 150 identify their area only by forecast
// zone code (`https://api.weather.gov/zones/forecast/WIZ050`). Plotting only the
// ones with polygons would silently drop 85% of active weather — which is the
// exact failure this project argues against everywhere else.
//
// The zone list endpoint does not return geometry even with
// `include_geometry=true`, so each zone has to be fetched individually. That is
// far too slow to do in a browser at load time, and it is stable data — zone
// boundaries change on the order of years. So it is a build step whose output is
// committed, the same shape as the Natural Earth files in public/ne/.
//
// ── run it deliberately ─────────────────────────────────────────────────────
//
//   npm run build:assets
//
// NOT wired into `npm run build` and NOT run in CI, for the same reason
// sources/index.ts is a static array rather than a glob: this writes a file that
// every alert's position depends on, and that belongs in a diff a human read.
// ────────────────────────────────────────────────────────────────────────────
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '../public/nws/zone-centroids.json')

// Node sends no browser User-Agent, and api.weather.gov asks scripts to identify
// themselves. A contact address is the documented courtesy.
const UA = 'parallax-build (https://github.com/ethan-goldstein/parallax)'
const CONCURRENCY = 16

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/geo+json' } })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json()
}

/**
 * Area-weighted centroid of the largest ring.
 *
 * The vertex mean is NOT good enough: a zone traced with many points along one
 * coast and few inland pulls its mean toward the detailed edge, which for a
 * coastal county puts the marker in the sea. The shoelace centroid is invariant
 * to how densely each edge happens to be sampled.
 *
 * Degenerate rings (zero area, which a few offshore zones really do produce)
 * fall back to the vertex mean, because a divide by zero here would emit NaN and
 * the alert would silently vanish from the map.
 */
function ringCentroid(ring) {
  let twiceArea = 0
  let x = 0
  let y = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x0, y0] = ring[j]
    const [x1, y1] = ring[i]
    const f = x0 * y1 - x1 * y0
    twiceArea += f
    x += (x0 + x1) * f
    y += (y0 + y1) * f
  }
  if (Math.abs(twiceArea) < 1e-12) {
    const n = ring.length || 1
    return [
      ring.reduce((a, p) => a + p[0], 0) / n,
      ring.reduce((a, p) => a + p[1], 0) / n,
    ]
  }
  const k = 1 / (3 * twiceArea)
  return [x * k, y * k]
}

function ringArea(ring) {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  }
  return Math.abs(a / 2)
}

/** GeoJSON geometry → [lat, lon], or null when there is nothing usable. */
function centroidOf(geometry) {
  if (!geometry) return null
  // Outer rings only. A zone with a hole in it is still centred on its body.
  const rings =
    geometry.type === 'Polygon'
      ? [geometry.coordinates[0]]
      : geometry.type === 'MultiPolygon'
        ? geometry.coordinates.map((poly) => poly[0])
        : []

  const usable = rings.filter((r) => Array.isArray(r) && r.length >= 3)
  if (usable.length === 0) return null

  // Largest part wins. An archipelago zone centred on the mean of its islands
  // would sit in open water between them.
  let best = usable[0]
  let bestArea = ringArea(usable[0])
  for (const r of usable.slice(1)) {
    const a = ringArea(r)
    if (a > bestArea) {
      best = r
      bestArea = a
    }
  }

  const [lon, lat] = ringCentroid(best)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  return [Math.round(lat * 1e4) / 1e4, Math.round(lon * 1e4) / 1e4]
}

async function pool(items, worker) {
  const results = []
  let cursor = 0
  let done = 0
  const runners = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      try {
        results.push(await worker(items[i]))
      } catch {
        // One unreachable zone must not fail the build. It simply has no
        // centroid, and the adapter already handles a missing one by dropping
        // that alert with a stated count rather than plotting it at (0, 0).
        results.push(null)
      }
      if (++done % 250 === 0) process.stderr.write(`  ${done}/${items.length}\n`)
    }
  })
  await Promise.all(runners)
  return results
}

async function main() {
  const types = ['forecast', 'county']
  const zones = new Map()

  for (const type of types) {
    process.stderr.write(`listing ${type} zones…\n`)
    const list = await getJson(
      `https://api.weather.gov/zones?type=${type}&include_geometry=false`,
    )
    for (const f of list.features) {
      const id = f.properties?.id
      // `@id` is the canonical self link; building the URL by hand would guess
      // at the sub-path, and forecast zones live under /zones/forecast/ while
      // the list says type "public".
      const url = f.properties?.['@id'] ?? f.id
      if (id && url) zones.set(id, url)
    }
  }

  process.stderr.write(`fetching geometry for ${zones.size} zones…\n`)
  const entries = [...zones.entries()]
  const fetched = await pool(entries, async ([id, url]) => {
    const z = await getJson(url)
    const c = centroidOf(z.geometry)
    return c ? [id, c] : null
  })

  const table = Object.fromEntries(fetched.filter(Boolean).sort((a, b) => (a[0] < b[0] ? -1 : 1)))
  const missing = zones.size - Object.keys(table).length

  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(table))

  process.stderr.write(
    `wrote ${Object.keys(table).length} centroids to ${OUT}` +
      (missing > 0 ? ` (${missing} zones had no usable geometry)\n` : '\n'),
  )
}

await main()
