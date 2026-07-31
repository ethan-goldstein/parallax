# 0007. Network lookups are ingested as facts, not rendered in a side panel

**Status:** accepted, Phase 10.

## Context

The RECON tab runs network lookups from the browser — DNS-over-HTTPS, RDAP, RIPEstat, Shodan's
InternetDB, the MITRE CVE record. All five are keyless and CORS-open, so they need no backend and the
no-backend constraint survives intact.

The obvious implementation is a panel that fetches, renders, and forgets. Every OSINT dashboard does
it that way, and it is less code.

## Decision

Every lookup is normalised into facts and committed through the same `Ingestor` as every feed, via
`ingestOne`. A lookup produces a transaction on the system axis, appears in the audit trail, is
subject to the duplicate guard and the monotonic clamp, and is queryable through the query language
alongside earthquakes.

## Why

**1. The engine already does this to itself.** `Session::record_audit` writes every policy decision
into the store as ordinary facts, and `policy.hpp` argues at length for why: an audit trail kept
beside the store can drift from it, and one that might differ from the record is not an audit trail. If
the system's own decisions are facts, a DNS answer certainly is. An ephemeral panel would introduce a
second, unaudited data path into an application whose central claim is that there is exactly one.

**2. A lookup is the cleanest bitemporal object in the codebase.** Every feed here needs its two axes
teased apart, and for two of them (EONET, and the curated port file) one axis has to be argued for.
DNS just states it: the answer arrives with a **TTL**, an explicit validity interval with an end,
published by the source rather than inferred by this code. RDAP carries registration and expiry dates.
So the store gets `validTo` values that are not a judgement call — which is rarer here than it should
be.

**3. It is the demonstration, run on the visitor's own data.** Look a domain up, wait, look it up
again. If the record changed there are now two versions of one entity, the change sits on the system
axis, and the inspector shows them in order. That is the entire thesis of the project, performed on
data the visitor produced in the last thirty seconds, which is more convincing than any feed can be.

**4. It fills the `network` category honestly** rather than leaving an empty tab, and every lookup
passes through the policy engine and lands in the audit log the engine tab is displaying while you
use it.

## The boundary, and where it is enforced

RDAP returns registrant name, email, postal address and telephone number for a large share of domains.

**None of it is ingested.** It is dropped in the adapter, before a fact is constructed — not filtered
at query time. The distinction is the whole point: refusing to *return* person-linked data is a
property of a query path that can be changed; refusing to *collect* it is a property of the store.
`README.md` states that `Sensitivity.PersonLinked` exists so the type system can express the category
this project declines to collect, and until now nothing exercised that claim. This does.

The count of discarded fields is shown to the user, because a silent drop and an empty upstream record
look identical.

## Consequences

- **No port scanning.** A browser cannot open arbitrary sockets. This would decline to be a scanning
  tool if it could, and the exposure probe reads an index Shodan already published rather than
  generating traffic to a third party.
- **No IP geolocation.** Results are placed at the registered country of the announcing AS — a fact
  about a registry entry, read from the `country:` attribute in the whois record. IP geolocation is
  wrong often enough that plotting its output as a position would be the confident overclaim this
  project spends its data model arguing against. The country centroid cannot be mistaken for
  precision, which is the property that makes it acceptable.
- **The country table is authored and incomplete.** An unlisted country yields no position, and the
  lookup is reported without being plotted. That is the honest outcome and better than inventing one.
- **`crt.sh` is excluded.** Certificate-transparency enumeration would be the natural sixth probe, and
  it sends no CORS headers — unreachable from a static page, and not worth a proxy that would break
  the no-backend constraint for one feature.
- **The probes are deliberately NOT in `SOURCE_SPECS`.** They have no unattended `fetch`, and putting
  them there would drag them into the boot cycle and the poll scheduler, where a lookup nobody asked
  for would run on a timer. Their attributes are registered explicitly through a second argument to
  `registerAttributes`, so the guarantee that no attribute reaches the store without a declared
  sensitivity still holds in one place.
- **System time is the moment of asking, and legitimately so.** Elsewhere in this codebase using a
  fetch clock as the system axis is a compromise (EONET) that the duplicate guard has to work around.
  Here it is exact: for an interactive query, the moment the client asked *is* when this knowledge
  entered the store.
- **The licence machinery gets exercised by a user action.** InternetDB is free for non-commercial use
  with attribution, so running a lookup causes the obligations panel to gain a non-commercial term —
  an obligation appearing at the moment it is incurred, which is what `nonCommercial` was added for.

## What was rejected

**A results panel with no store involvement.** Simpler, and it would make the store's scope an
accident of which data happened to arrive on a timer rather than a principle.

**Writing the full RDAP record and refusing it at query time under R1.** A flashier demonstration of
the policy engine, and a worse principle. Collecting person-linked data in order to demonstrate
refusing to show it is not a defensible trade when not collecting it is available.
