// ── web/src/sources/ports.ts ────────────────────────────────────────────────
// Major ports and maritime chokepoints, from a dataset committed to this repo.
//
// ── why a static source exists at all ───────────────────────────────────────
//
// The maritime layer is fed by Finnish AIS, which covers the Baltic and the Gulf
// of Finland and nothing else. On a globe that reads as "maritime data does not
// exist" — a viewer sees one bright smudge near Helsinki and concludes the layer
// is broken. Keyless global AIS is not available at any price a static site can
// pay (digitraffic.ts documents rejecting the alternatives), so the honest fix is
// not to fake vessel traffic but to draw the fixed infrastructure the traffic
// moves between, and to say plainly that that is what it is.
//
// ── the system time of a file ───────────────────────────────────────────────
//
// A static dataset has exactly one system time: when it was authored. That is
// read from the file's own `authoredUnix` and never from `Date.now()`, because a
// fetch clock would mint a new system time on every reload and the store would
// accumulate a fresh "we learned this" event every time somebody opened the page.
//
// The useful consequence is that these facts land at the very bottom of the
// system axis and stay there. Scrub the axis back to the beginning and the ports
// are the only thing left on the map — the fixed reference frame that everything
// else has been moving against the whole time.
// ────────────────────────────────────────────────────────────────────────────
import { Kind, OPEN_VALID, toTimestamp, writeF64Bits, writeGeo, writeSymBits } from '../engine/abi'
import { type Batch, type EntityRegistry } from './batch'
import { SOURCES } from './registry'
import { Sensitivity, type SourceSpec } from './spec'

const ASSET = 'ports/ports.json'

interface PortRecord {
  name: string
  country: string
  lat: number
  lon: number
  class: number
  /** `way/123` — the OSM element this coordinate came from, where one exists. */
  osm?: string
}

interface ChokepointRecord {
  name: string
  lat: number
  lon: number
  osm?: string
}

export interface PortsFile {
  authoredUnix: number
  ports: PortRecord[]
  chokepoints: ChokepointRecord[]
}

function isFinitePair(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  )
}

export async function fetchPorts(signal?: AbortSignal): Promise<PortsFile> {
  // BASE_URL, not a leading slash: this deploys under /parallax/ on Pages, and
  // an absolute path would 404 there while working perfectly in dev.
  const url = `${import.meta.env.BASE_URL}${ASSET}`
  const res = await fetch(url, signal ? { signal } : {})
  if (!res.ok) throw new Error(`ports asset ${res.status}`)

  const body = (await res.json()) as Partial<PortsFile>
  if (typeof body.authoredUnix !== 'number' || !Array.isArray(body.ports)) {
    throw new Error('ports asset is malformed')
  }
  return {
    authoredUnix: body.authoredUnix,
    ports: body.ports.filter((p) => isFinitePair(p?.lat, p?.lon)),
    chokepoints: (body.chokepoints ?? []).filter((c) => isFinitePair(c?.lat, c?.lon)),
  }
}

export const portsSpec: SourceSpec<PortsFile> = {
  id: SOURCES.ports!.id,
  key: 'ports',
  label: 'ports · curated',
  layer: 'ports',
  assets: [ASSET],
  coverageNote:
    'curated selection, coordinates from OpenStreetMap — a port spanning tens of km is drawn at one point',
  attributes: [
    { name: 'port_position', sensitivity: Sensitivity.Public },
    // A berth is not a person and not a moving asset. Public.
    { name: 'port_class', sensitivity: Sensitivity.Public },
    { name: 'port_label', sensitivity: Sensitivity.Public },
  ],
  fetch: (signal) => fetchPorts(signal),
  normalize(raw, ctx) {
    const facts: Batch['facts'] = []
    const registry: EntityRegistry = ctx.registry
    // One transaction, at the moment the file was written. Not bucketed: there
    // is only one instant here, and bucketBatches over a single timestamp would
    // return the same single batch with more ceremony.
    const validFrom = toTimestamp(raw.authoredUnix)

    for (const p of raw.ports) {
      const entity = registry.idFor(`port:${p.name}`)
      facts.push({
        entity,
        attr: ctx.attrs.port_position!,
        kind: Kind.Geo,
        validFrom,
        // A port does not stop existing. OPEN_VALID is the honest bound.
        validTo: OPEN_VALID,
        source: SOURCES.ports!.id,
        writePayload: (view, off) => writeGeo(view, off, p.lat, p.lon),
      })
      facts.push({
        entity,
        attr: ctx.attrs.port_class!,
        kind: Kind.F64,
        validFrom,
        validTo: OPEN_VALID,
        source: SOURCES.ports!.id,
        writePayload: (view, off) => writeF64Bits(view, off, p.class),
      })
      facts.push({
        entity,
        attr: ctx.attrs.port_label!,
        kind: Kind.Sym,
        validFrom,
        validTo: OPEN_VALID,
        source: SOURCES.ports!.id,
        writePayload: (view, off) =>
          writeSymBits(view, off, ctx.intern(`${p.name} — ${p.country}`)),
      })
    }

    return {
      batches: facts.length > 0 ? [{ wallClockUnix: raw.authoredUnix, facts }] : [],
      count: raw.ports.length,
    }
  },
}

export const chokepointsSpec: SourceSpec<PortsFile> = {
  id: SOURCES.chokepoints!.id,
  key: 'chokepoints',
  label: 'chokepoints · curated',
  layer: 'chokepoints',
  assets: [ASSET],
  coverageNote: 'the passages global shipping cannot route around — position only, no traffic',
  attributes: [
    { name: 'chokepoint_position', sensitivity: Sensitivity.Public },
    // Deliberately no severity, risk score or traffic volume. Those would be
    // editorial judgements dressed as measurements, and the legend would draw a
    // ramp implying an ordering nothing in this dataset supports.
    { name: 'chokepoint_label', sensitivity: Sensitivity.Public },
  ],
  fetch: (signal) => fetchPorts(signal),
  normalize(raw, ctx) {
    const facts: Batch['facts'] = []
    const validFrom = toTimestamp(raw.authoredUnix)

    for (const c of raw.chokepoints) {
      const entity = ctx.registry.idFor(`chokepoint:${c.name}`)
      facts.push({
        entity,
        attr: ctx.attrs.chokepoint_position!,
        kind: Kind.Geo,
        validFrom,
        validTo: OPEN_VALID,
        source: SOURCES.chokepoints!.id,
        writePayload: (view, off) => writeGeo(view, off, c.lat, c.lon),
      })
      facts.push({
        entity,
        attr: ctx.attrs.chokepoint_label!,
        kind: Kind.Sym,
        validFrom,
        validTo: OPEN_VALID,
        source: SOURCES.chokepoints!.id,
        writePayload: (view, off) => writeSymBits(view, off, ctx.intern(c.name)),
      })
    }

    return {
      batches: facts.length > 0 ? [{ wallClockUnix: raw.authoredUnix, facts }] : [],
      count: raw.chokepoints.length,
    }
  },
}
