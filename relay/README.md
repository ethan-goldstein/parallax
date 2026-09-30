# The ADS-B relay

One Cloudflare Worker, one file, no state. It adds the `Access-Control-Allow-Origin` header that
no community ADS-B aggregator sends, and does nothing else.

## Why it exists

Until 2026 the aviation layers read [airplanes.live](https://airplanes.live/) directly from the
browser. That endpoint now answers `403` with a request to email the project, and the remaining
aggregators (adsb.fi, adsb.lol, adsb.one, OpenSky) all serve JSON without CORS headers. A static
page cannot read any of them. The relay is the smallest thing that restores the layer without
pretending the situation is other than it is.

## What it is not

- **Not an open proxy.** Two paths exist, `/mil` and `/point/{lat}/{lon}/{nm}`, and the upstream
  hosts are fixed in the source. A request with an `Origin` outside the allowlist gets `403`.
- **Not a key holder.** The upstreams are keyless. There is no secret in the Worker and nothing in
  its config.
- **Not a load multiplier.** Responses are edge-cached for ten seconds, so a burst of visitors is
  one upstream request per endpoint per ten seconds, well inside adsb.fi's one-per-second limit.

## Deploy

```bash
cd relay
npx wrangler login
npx wrangler deploy
```

`deploy` prints a `https://parallax-adsb-relay.<account>.workers.dev` URL. Give it to the build:

```bash
# local builds
echo 'VITE_ADSB_RELAY=https://parallax-adsb-relay.<account>.workers.dev' > web/.env

# the GitHub Pages deploy
gh variable set ADSB_RELAY --body 'https://parallax-adsb-relay.<account>.workers.dev'
gh workflow run deploy.yml
```

Without the variable the site still builds and runs; the two aviation layers report that no relay
is configured and say why, rather than showing an empty sky that looks like a broken layer.

## Upstream terms

adsb.fi: personal, non-commercial use; cite adsb.fi with a link. The page renders that attribution
in the obligations panel whenever the layer has data. adsb.lol publishes no terms and is used only
if adsb.fi does not answer.
