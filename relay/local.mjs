// ── relay/local.mjs ─────────────────────────────────────────────────────────
// The residential half of the relay. A Node process that binds loopback only,
// is reached through a Tailscale Funnel, and answers nothing without the
// shared token the Worker sends.
//
// ── why this exists ─────────────────────────────────────────────────────────
//
// The Worker in worker.js was meant to be the whole relay. It still is, from
// the page's point of view. But adsb.fi answers 403 and adsb.lol 429 to the
// shared egress addresses Cloudflare Workers fetch from, and both serve a home
// connection without complaint. So the Worker forwards here, and this does the
// one upstream fetch from an address the aggregators are willing to talk to.
//
// ── what it refuses to be ───────────────────────────────────────────────────
//
//   - reachable without the token: a request without `x-relay-token` matching
//     ~/.config/parallax-relay/token gets 403, so the Funnel hostname being
//     public does not make this an open relay
//   - a proxy: the same two paths as the Worker, resolved by the same route()
//   - a load multiplier: answers are cached for CACHE_MS per path, so the
//     Worker's own cache missing on several edges still costs the upstream one
//     request per ten seconds
//
// Runs under launchd as com.ethangoldstein.parallax-relay; see relay/README.md.
// ────────────────────────────────────────────────────────────────────────────
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { fromUpstream, route } from './upstream.js'

const PORT = Number(process.env.PORT ?? 8791)
const HOST = '127.0.0.1'
const CACHE_MS = 10_000

const TOKEN_PATH = process.env.RELAY_TOKEN_FILE ?? join(homedir(), '.config/parallax-relay/token')
const TOKEN = readFileSync(TOKEN_PATH, 'utf8').trim()
if (TOKEN.length < 32) {
  console.error(`relay token at ${TOKEN_PATH} is too short to be one`)
  process.exit(1)
}

/** path key → { at, text, upstream } */
const cache = new Map()

function send(res, status, body, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...extra })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

const server = createServer(async (req, res) => {
  if (req.headers['x-relay-token'] !== TOKEN) return send(res, 403, { error: 'forbidden' })
  if (req.method !== 'GET') return send(res, 405, { error: 'GET only' })

  const r = route(new URL(req.url, 'http://local').pathname)
  if (!r) return send(res, 404, { error: 'unknown path' })

  const hit = cache.get(r.key)
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return send(res, 200, hit.text, { 'x-parallax-upstream': hit.upstream, 'x-relay-cache': 'hit' })
  }

  const out = await fromUpstream(r)
  if (out.error) return send(res, 502, { error: out.error })

  cache.set(r.key, { at: Date.now(), text: out.text, upstream: out.upstream })
  // Point queries are keyed by viewport, so a map being panned leaves entries
  // behind. Bounded rather than leaked.
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) cache.delete(oldest[0])
  }
  send(res, 200, out.text, { 'x-parallax-upstream': out.upstream, 'x-relay-cache': 'miss' })
})

server.listen(PORT, HOST, () => {
  console.log(`[parallax-relay] listening on http://${HOST}:${PORT}, token from ${TOKEN_PATH}`)
})
