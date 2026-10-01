// ── relay/worker.js ─────────────────────────────────────────────────────────
// The public face of the ADS-B relay. Cloudflare Worker, one file plus the
// shared upstream.js.
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
// This is the smallest thing that restores the layer honestly: a pass-through
// that adds the CORS header the upstream does not, holds no key, stores
// nothing, and cannot be pointed at any other host.
//
// ── and why it forwards to a laptop ─────────────────────────────────────────
//
// The first deployment fetched the aggregators directly from here, and both
// refused: adsb.fi 403, adsb.lol 429. Cloudflare Workers egress from shared
// addresses that every other Worker on the platform also uses, and the
// aggregators have had their fill of cloud traffic. A home connection is
// served without complaint. So when MAC_RELAY_URL and RELAY_TOKEN are set,
// the fetch is delegated to local.mjs over a Tailscale Funnel, with the
// token so the Funnel hostname being public does not make that an open relay.
// Without them, the Worker tries the aggregators itself and reports exactly
// what they said.
//
// ── what it refuses to be ───────────────────────────────────────────────────
//
//   - an open proxy: only the two paths in upstream.js exist, and every host
//     is fixed in source rather than taken from the request
//   - a way round the upstream's terms: adsb.fi is non-commercial with
//     attribution, and the page renders that attribution; responses are
//     edge-cached for CACHE_SECONDS so N viewers cost the upstream one request
//   - reachable from anywhere: the Origin allowlist is the deployed site and
//     the local preview ports, and everything else gets 403
// ────────────────────────────────────────────────────────────────────────────
import { fromUpstream, route } from './upstream.js'

/** Where the page is served from. Anything else is refused. */
const ALLOWED_ORIGINS = new Set([
  'https://ethan-goldstein.github.io',
  'http://localhost:4173',
  'http://localhost:4174',
  'http://localhost:5181',
])

/**
 * How long one upstream answer is served to every viewer.
 *
 * The page polls every twenty seconds. Ten seconds here means a burst of
 * visitors costs the upstream at most one request per ten seconds per
 * endpoint, well inside adsb.fi's one-request-per-second limit, and no viewer
 * sees a position more than ten seconds older than they would have without
 * the relay.
 */
const CACHE_SECONDS = 10

const EDGE_CACHE = { cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true } }

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

/**
 * Asks the residential relay, when one is configured.
 *
 * Returns the same shape as fromUpstream so the caller does not care which
 * path answered. A failure here falls through to the direct attempt, which
 * will most likely be refused too, but reporting both is more useful than
 * reporting either alone.
 */
async function fromMac(r, env) {
  const base = env.MAC_RELAY_URL?.replace(/\/+$/, '')
  if (!base || !env.RELAY_TOKEN) return null
  try {
    const res = await fetch(`${base}${r.key}`, {
      ...EDGE_CACHE,
      headers: { 'x-relay-token': env.RELAY_TOKEN, accept: 'application/json' },
    })
    if (!res.ok) {
      let detail = String(res.status)
      try {
        const body = await res.json()
        if (typeof body.error === 'string') detail = `${res.status} ${body.error}`
      } catch {
        // Not JSON; the status is what there is.
      }
      return { error: `home relay ${detail}` }
    }
    const text = await res.text()
    const body = JSON.parse(text)
    if (!Array.isArray(body.ac)) return { error: 'home relay returned no ac array' }
    return { text, upstream: res.headers.get('x-parallax-upstream') ?? 'home relay' }
  } catch (err) {
    return { error: `home relay: ${String(err).slice(0, 80)}` }
  }
}

export default {
  async fetch(request, env) {
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
    if (!r) {
      return json({ error: 'unknown path; only /mil and /point/{lat}/{lon}/{nm} exist' }, 404, origin)
    }

    let out = await fromMac(r, env)
    if (!out || out.error) {
      const direct = await fromUpstream(r, EDGE_CACHE)
      out = direct.error && out?.error ? { error: `${out.error}; direct: ${direct.error}` } : direct
    }
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
