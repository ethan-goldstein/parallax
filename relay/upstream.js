// ── relay/upstream.js ───────────────────────────────────────────────────────
// The part of the relay that talks to the aggregators. Shared by worker.js
// (Cloudflare) and local.mjs (Node, on a machine with a residential address),
// so the two cannot disagree about which hosts exist or how a path maps.
//
// Why there are two places this runs: adsb.fi answers 403 and adsb.lol 429 to
// Cloudflare's shared egress addresses. Both serve a home connection without
// complaint. So the Worker stays the public face (origin lock, edge cache) and
// hands the actual upstream fetch to a small process on a residential IP.
// ────────────────────────────────────────────────────────────────────────────

/**
 * adsb.fi first, adsb.lol second. Both serve the readsb/ADSBexchange v2 JSON
 * shape, so the client does not care which one answered. adsb.fi publishes
 * terms (personal, non-commercial, cite and link); adsb.lol publishes none.
 * A source with stated terms is preferred over one whose terms are unknown.
 */
export const UPSTREAMS = [
  {
    name: 'adsb.fi',
    mil: 'https://opendata.adsb.fi/api/v2/mil',
    point: (lat, lon, nm) => `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${nm}`,
  },
  {
    name: 'adsb.lol',
    mil: 'https://api.adsb.lol/v2/mil',
    point: (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}`,
  },
]

/** Upstream cap. Asking for more is an error there, so it is clamped here. */
export const MAX_RADIUS_NM = 250

export const USER_AGENT = 'parallax-relay/1.0 (+https://github.com/ethan-goldstein/parallax)'

const NUM = /^-?\d{1,3}(\.\d{1,4})?$/

/**
 * Resolves a request path to what it asks for, or null.
 *
 * Only two shapes exist: `/mil`, and `/point/{lat}/{lon}/{nm}`. Anything else
 * is not a request this relay forwards, which is what keeps it from being a
 * proxy.
 */
export function route(pathname) {
  if (pathname === '/mil') return { kind: 'mil', key: '/mil' }

  const m = pathname.match(/^\/point\/([^/]+)\/([^/]+)\/(\d{1,3})$/)
  if (!m) return null
  const [, lat, lon, nmRaw] = m
  if (!NUM.test(lat) || !NUM.test(lon)) return null
  const la = Number(lat)
  const lo = Number(lon)
  if (la < -90 || la > 90 || lo < -180 || lo > 180) return null
  const nm = Math.min(MAX_RADIUS_NM, Math.max(1, Number(nmRaw)))
  return { kind: 'point', lat, lon, nm, key: `/point/${lat}/${lon}/${nm}` }
}

/**
 * Fetches one routed request from the first upstream that answers properly.
 *
 * `fetchInit` lets the Worker add its edge-cache options; Node ignores them.
 * Returns `{ text, upstream }` or `{ error }` naming every upstream's failure,
 * because when both refuse, the operator needs to know whether it was the same
 * reason twice.
 */
export async function fromUpstream(r, fetchInit = {}) {
  const errors = []
  for (const up of UPSTREAMS) {
    const url = r.kind === 'mil' ? up.mil : up.point(r.lat, r.lon, r.nm)
    try {
      const res = await fetch(url, {
        ...fetchInit,
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      })
      if (!res.ok) {
        errors.push(`${up.name} ${res.status}`)
        continue
      }
      const text = await res.text()
      // Parsed once, to refuse to relay anything that is not the JSON shape the
      // client expects. A relay that forwards an HTML error page as 200 is a
      // relay that turns one failure into a confusing second one.
      const body = JSON.parse(text)
      if (!Array.isArray(body.ac)) {
        errors.push(`${up.name} returned no ac array`)
        continue
      }
      return { text, upstream: up.name }
    } catch (err) {
      errors.push(`${up.name}: ${String(err).slice(0, 80)}`)
    }
  }
  return { error: errors.length ? errors.join('; ') : 'no upstream answered' }
}
