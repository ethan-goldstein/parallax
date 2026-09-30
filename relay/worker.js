// ── relay/worker.js ─────────────────────────────────────────────────────────
// A CORS relay for ADS-B, and nothing else. Cloudflare Worker, one file.
//
// ── why this exists ─────────────────────────────────────────────────────────
//
// For its first year this project fetched aircraft straight from the browser:
// airplanes.live was keyless and CORS-open, and "no backend" was literally
// true for every layer. In 2026 airplanes.live withdrew anonymous access (the
// API now returns 403 with a request to email the project), and none of the
// other community aggregators (adsb.fi, adsb.lol, adsb.one, OpenSky) send an
// Access-Control-Allow-Origin header. There is, as of this writing, no
// keyless ADS-B feed a static page can read.
//
// So this is the smallest thing that restores the layer honestly: a stateless
// pass-through that adds the CORS header the upstream does not. It holds no
// key, stores nothing, and cannot be pointed at any other host. The README
// says exactly this, because "no backend" was a claim worth being precise
// about once it stopped being wholly true.
//
// ── what it refuses to be ───────────────────────────────────────────────────
//
//   - an open proxy: only the two paths below exist, and the upstream host is
//     fixed in this file rather than taken from the request
//   - a way round the upstream's terms: adsb.fi is non-commercial with
//     attribution, and the page renders that attribution; responses are
//     cached for CACHE_SECONDS so N viewers cost the upstream one request
//   - reachable from anywhere: the Origin allowlist is the deployed site and
//     the two local preview ports, and everything else gets 403
// ────────────────────────────────────────────────────────────────────────────

/** Where the page is served from. Anything else is refused. */
const ALLOWED_ORIGINS = new Set([
  'https://ethan-goldstein.github.io',
  'http://localhost:4173',
  'http://localhost:4174',
  'http://localhost:5181',
])

/**
 * adsb.fi first, adsb.lol second. Both serve the readsb/ADSBexchange v2 JSON
 * shape, so the client does not care which one answered. adsb.fi publishes
 * terms (personal, non-commercial, cite and link); adsb.lol publishes none.
 * A source with stated terms is preferred over one whose terms are unknown.
 */
const UPSTREAMS = [
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

/**
 * How long one upstream answer is served to every viewer.
 *
 * The page polls every twenty seconds. Ten seconds here means a burst of
 * visitors costs adsb.fi at most one request per ten seconds per endpoint,
 * well inside its one-request-per-second limit, and no viewer sees a position
 * more than ten seconds older than they would have without the relay.
 */
const CACHE_SECONDS = 10

/** Upstream cap. Asking for more is an error there, so it is clamped here. */
const MAX_RADIUS_NM = 250

const NUM = /^-?\d{1,3}(\.\d{1,4})?$/

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET',
    'access-control-max-age': '86400',
    vary: 'origin',
  }
}

function json(body, status, origin, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(origin), ...extra },
  })
}

/** Resolves a request path to the upstream URL it maps to, or null. */
function route(pathname) {
  if (pathname === '/mil') return { kind: 'mil' }

  // /point/{lat}/{lon}/{nm}
  const m = pathname.match(/^\/point\/([^/]+)\/([^/]+)\/(\d{1,3})$/)
  if (!m) return null
  const [, lat, lon, nmRaw] = m
  if (!NUM.test(lat) || !NUM.test(lon)) return null
  const la = Number(lat)
  const lo = Number(lon)
  if (la < -90 || la > 90 || lo < -180 || lo > 180) return null
  const nm = Math.min(MAX_RADIUS_NM, Math.max(1, Number(nmRaw)))
  return { kind: 'point', lat, lon, nm }
}

async function fromUpstream(r, ctx) {
  let lastErr = null
  for (const up of UPSTREAMS) {
    const url = r.kind === 'mil' ? up.mil : up.point(r.lat, r.lon, r.nm)
    try {
      const res = await fetch(url, {
        headers: {
          accept: 'application/json',
          // A real identity, so the upstream can see who is asking and why.
          'user-agent': 'parallax-relay/1.0 (+https://github.com/ethan-goldstein/parallax)',
        },
        // Cloudflare's edge cache, keyed on the upstream URL, so a burst of
        // viewers is one upstream fetch. cacheEverything is required because
        // the upstream sends no cache headers of its own.
        cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
      })
      if (!res.ok) {
        lastErr = `${up.name} ${res.status}`
        continue
      }
      const text = await res.text()
      // Parsed once, to refuse to relay anything that is not the JSON shape the
      // client expects. A relay that forwards an HTML error page as 200 is a
      // relay that turns one failure into a confusing second one.
      const body = JSON.parse(text)
      if (!Array.isArray(body.ac)) {
        lastErr = `${up.name} returned no ac array`
        continue
      }
      return { text, upstream: up.name }
    } catch (err) {
      lastErr = `${up.name}: ${String(err).slice(0, 80)}`
    }
  }
  return { error: lastErr ?? 'no upstream answered' }
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('origin') ?? ''
    const allowed = ALLOWED_ORIGINS.has(origin)

    // Preflight. Browsers send one for any non-simple request; a plain GET with
    // no custom headers usually skips it, but answering is cheap.
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: allowed ? 204 : 403,
        headers: allowed ? corsHeaders(origin) : {},
      })
    }

    if (request.method !== 'GET') {
      return json({ error: 'GET only' }, 405, allowed ? origin : 'null')
    }

    // A request with no Origin at all is a curl or a crawler, not the page.
    // Refused rather than served, so this cannot be used as a general-purpose
    // mirror of the upstream by anything other than the site it exists for.
    if (!allowed) {
      return json({ error: 'origin not allowed' }, 403, 'null')
    }

    const r = route(new URL(request.url).pathname)
    if (!r) return json({ error: 'unknown path; only /mil and /point/{lat}/{lon}/{nm} exist' }, 404, origin)

    const out = await fromUpstream(r, ctx)
    if (out.error) return json({ error: out.error }, 502, origin)

    return new Response(out.text, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': `public, max-age=${CACHE_SECONDS}`,
        // Which aggregator actually answered, so the page can say so.
        'x-parallax-upstream': out.upstream,
        'access-control-expose-headers': 'x-parallax-upstream',
        ...corsHeaders(origin),
      },
    })
  },
}
