# 0008. One relay for the aircraft feed, one snapshot for the element sets

**Status:** accepted, Phase 11.

## Context

The project's opening claim was "no backend, no API keys, no login": every source was keyless and
CORS-open, read by the browser directly. That was true when it was written. By September 2026 two
feeds had stopped working, for two different reasons, and neither had told anyone.

**Aircraft.** airplanes.live withdrew keyless access. Its API now answers `403` with a request to
email the project a description of what you are building. The remaining community aggregators
(adsb.fi, adsb.lol, adsb.one) and OpenSky all serve the same readsb JSON, and none of them sends an
`Access-Control-Allow-Origin` header. This was checked from the deployed origin with `fetch()`,
not inferred from curl, because curl does not enforce CORS and would have said everything was fine.
All five fail in the browser.

**Satellites.** CelesTrak stopped answering from the development machine's network: connections
time out, and from a second vantage point they are refused outright. CelesTrak's published policy
is one fetch per group every two hours, and this page was fetching four groups from every visitor's
browser on every load, more on every reload during development. Whether the block is specific to
this address or a wider outage is not knowable from here. The design was wrong either way.

Both layers had been reporting themselves as failed in the layer panel, correctly, for weeks. The
failure that matters is that a visitor sees "military air: failed" on a project whose README says
the feed is live, and has no way to tell a withdrawn API from a broken one.

## Decision

**Aircraft go through a relay** ([`relay/worker.js`](../../relay/worker.js)): a Cloudflare Worker
of one file that forwards exactly two paths to adsb.fi, with adsb.lol as fallback, adds the CORS
header, and edge-caches every answer for ten seconds. Its URL enters the build as
`VITE_ADSB_RELAY`. A build without it shows both aviation layers as failed with the full reason in
the panel.

**Element sets come from a snapshot** ([`web/scripts/fetch-tle.mjs`](../../web/scripts/fetch-tle.mjs)):
the deploy fetches the four CelesTrak groups once, serves them from the site's own origin, and runs
daily on a schedule. The client reads the snapshot first and fetches CelesTrak live only when a
build has no snapshot at all, which is the fresh-clone case. The script is fail-soft: if CelesTrak
does not answer, the previous snapshot is kept and the build proceeds.

## Why a relay is acceptable and a proxy is not

The word "backend" was doing two jobs in the original claim: no server the reader must trust with
their traffic, and no server the author must keep running for the page to work. The relay concedes
the second and holds the first as far as it can.

- **It cannot be aimed.** The upstream hosts are constants in the source. There is no `?url=`
  parameter. It is not a proxy in the sense that would make it a liability.
- **It holds nothing.** No key, no secret, no state, no log of who asked. The upstreams are keyless;
  the relay exists only because they omit one response header.
- **It refuses everyone else.** The `Origin` allowlist is this site and the local preview ports. A
  request with no `Origin` header (curl, a crawler) gets `403`, so the relay cannot become an
  unattributed mirror of adsb.fi for anything other than the page it serves.
- **It respects the upstream's terms better than the browser did.** adsb.fi asks for one request
  per second. The edge cache turns any number of viewers into one upstream request per ten seconds
  per endpoint, which a page fetching directly could not have promised.
- **It is named in the README and in the panel.** The attribution machinery already existed, so
  the relay's upstream is written into every fact as `SOURCES.adsb_fi` and the obligations panel
  gains adsb.fi's terms the moment the layer has data. The relay reports which aggregator answered
  in a response header, and the panel shows it.

The alternative that was rejected is a general relay that would have restored crt.sh for RECON
and any future feed with one deployment. 0007 already declined crt.sh for exactly this reason:
one feature is not worth a component that can forward arbitrary requests, and a general relay is
that component even when it is only ever used for two.

## Why a snapshot is the better design, not only a workaround

The satellite layer's system time is the TLE epoch, read from the element set itself. It was never
the moment of fetch. So a snapshot taken at 03:00 carrying an epoch of 01:00 lands on the system
axis at 01:00, exactly where a live fetch would have put it; the axis cannot tell the two apart,
and neither can the store. What changes is only how often CelesTrak is asked, which goes from once
per group per visitor per page load to once per group per day, from a single address. That is the
cadence CelesTrak asks for, and the layer loses nothing it had.

The one thing a viewer cannot read off the axis is which snapshot the elements came from, so the
layer panel says so, with the snapshot's time in UTC rather than a relative age that is only true
at the instant it was rendered.

## What the first deployment taught

The Worker was meant to be the whole relay. Deployed, it was refused by both aggregators: adsb.fi
`403`, adsb.lol `429`, on the very first request, from an address that had never asked before.
Cloudflare Workers fetch from egress addresses shared with every other Worker on the platform, and
the aggregators rate-limit and block by address. A residential connection, tested the same minute,
was served by both without complaint.

So the relay became two pieces. The Worker keeps everything that should face the public: the
`Origin` allowlist, the edge cache, the stable URL. The upstream fetch moved to
[`relay/local.mjs`](../../relay/local.mjs), a Node process bound to loopback on a machine with a
home address, reached through a Tailscale Funnel on one port and refusing any request without a
shared token. [`relay/upstream.js`](../../relay/upstream.js) is the one place the upstream hosts
and the path grammar live, imported by both, so the two halves cannot drift.

The cost is a machine that has to stay up. It already does: it runs other services under launchd
with sleep disabled, and the Worker reports a home-relay outage as exactly that rather than as an
empty layer. The alternative, spoofing a browser `User-Agent` from the Worker to get past adsb.fi's
block, was not considered: a `403` from an operator is an answer, not an obstacle.

## What it cost

- **The opening claim is no longer clean.** "No backend" is now "no backend beyond one stateless
  relay for one feed", and the README says so in the second sentence rather than in a footnote.
- **A deployment to keep running.** The Worker sits on a free tier with no state, so there is
  nothing to migrate or rotate, but it is a thing that can be switched off, and if it is, the
  aviation layers report it.
- **`SOURCES.airplanes_live` is retired, not removed.** Source id 2 is written into facts and must
  never be renumbered, so the entry stays with a note. The new upstream is id 12.
- **A fresh clone has no satellites until it runs the script.** The live fallback covers it when
  CelesTrak is reachable, and the panel reports the failure when it is not.

## What was caught on the way

Fixing the aviation layers exercised a path that had never run: the civil layer with data. The
licence panel looked licences up by the feed's scheduler key, which for the civil spec was not a
key in `SOURCES`, so the first poll to deliver civil aircraft threw inside the cycle callback and
the store was never redrawn. The lookup is now by source id, carried on every `FeedStatus`. It was
invisible because the civil layer had never had data on a page load anyone was watching.
