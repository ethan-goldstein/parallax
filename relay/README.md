# The ADS-B relay

Two small pieces, no state, one secret between them. Together they add the
`Access-Control-Allow-Origin` header that no community ADS-B aggregator sends, from an address the
aggregators are willing to serve.

## Why it exists

Until 2026 the aviation layers read [airplanes.live](https://airplanes.live/) directly from the
browser. That endpoint now answers `403` with a request to email the project, and the remaining
aggregators (adsb.fi, adsb.lol, adsb.one, OpenSky) all serve JSON without CORS headers. A static
page cannot read any of them.

## Why it is two pieces

The first version was the Worker alone, fetching the aggregators from Cloudflare. Both refused:
adsb.fi `403`, adsb.lol `429`. Workers egress from shared addresses that every other Worker also
uses, and the aggregators have had enough cloud traffic. A home connection is served without
complaint. So:

- [`worker.js`](worker.js), **the public face.** Cloudflare Worker. Holds the `Origin` allowlist,
  edge-caches every answer for ten seconds, and forwards the two permitted paths to the home relay
  with a shared token. Falls back to fetching the aggregators directly and reports exactly what
  they said if the home relay is down.
- [`local.mjs`](local.mjs), **the residential half.** A Node process bound to loopback on a machine
  with a home address, reached through a Tailscale Funnel on port 8443, that refuses any request
  without the token and does the single upstream fetch. Runs under launchd.
- [`upstream.js`](upstream.js), shared by both, so they cannot disagree about which hosts exist.

## What it is not

- **Not an open proxy.** Two paths exist, `/mil` and `/point/{lat}/{lon}/{nm}`, and the upstream
  hosts are constants in `upstream.js`. The Worker refuses any `Origin` outside the allowlist; the
  home relay refuses any request without the token.
- **Not a key holder for anything upstream.** The aggregators are keyless. The only secret is the
  token the two halves share, set with `wrangler secret put` and read from a mode-600 file.
- **Not a load multiplier.** The Worker caches at the edge and the home relay caches in memory, both
  for ten seconds, so a burst of visitors is one upstream request per endpoint per ten seconds,
  well inside adsb.fi's one-per-second limit.

## Deploy

Home relay, on the machine with the residential address:

```bash
mkdir -p ~/.config/parallax-relay && chmod 700 ~/.config/parallax-relay
openssl rand -hex 24 > ~/.config/parallax-relay/token && chmod 600 ~/.config/parallax-relay/token
# launchd plist: node relay/local.mjs with PORT=8791 (see the one in ~/Library/LaunchAgents)
tailscale funnel --bg --https=8443 8791      # one-time: enable Funnel in the Tailscale admin
```

Worker:

```bash
cd relay
npx wrangler login
npx wrangler secret put RELAY_TOKEN < ~/.config/parallax-relay/token
npx wrangler deploy                           # prints the *.workers.dev URL
```

Then give the URL to the build:

```bash
echo 'VITE_ADSB_RELAY=https://parallax-adsb-relay.<account>.workers.dev' > web/.env   # local
gh variable set ADSB_RELAY --body 'https://parallax-adsb-relay.<account>.workers.dev'  # Pages
gh workflow run deploy.yml
```

Without the variable the site still builds and runs; the two aviation layers report that no relay
is configured and say why, rather than showing an empty sky that looks like a broken layer.

## Upstream terms

adsb.fi: personal, non-commercial use; cite adsb.fi with a link. The page renders that attribution
in the obligations panel whenever the layer has data. adsb.lol publishes no terms and is used only
if adsb.fi does not answer.
