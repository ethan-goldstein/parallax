// ── web/src/sources/registry.ts ─────────────────────────────────────────────
// Every data source, with its license and the obligations that come with it.
//
// This is the seed of the provenance system that Phase 7 surfaces in the UI.
// It lives here from the start rather than being retrofitted because a
// SourceId is written into every single fact at ingest time — bolting
// attribution on afterwards would mean it is decorative, and the whole point
// is that it is not.
//
// `shareAlike` and `nonCommercial` are the fields that will make the export
// license-conflict check work: a result set mixing ODbL and a permissive
// source carries obligations the user needs to be told about BEFORE they
// publish something derived from it.
// ────────────────────────────────────────────────────────────────────────────

export interface SourceMeta {
  /** Stable numeric id written into every fact. Never renumber these — they
   *  are persisted in snapshots. */
  id: number
  key: string
  name: string
  url: string
  license: string
  spdx: string
  attribution: string
  /** Derived works must carry the same license (ODbL, CC BY-SA). */
  shareAlike: boolean
  /** Free for a portfolio, not for a product. */
  nonCommercial: boolean
  /** Observed round-trip from a deployed origin, for the UI's honesty about
   *  which feeds are slow. */
  typicalMs: number
}

export const SOURCES: Record<string, SourceMeta> = {
  // Ids are written into every fact and persisted, so they are never renumbered.
  // 7 is the next free one.
  recon: {
    id: 11,
    key: 'recon',
    name: 'Network lookups — DNS.google, RDAP.org, RIPEstat, Shodan InternetDB, MITRE CVE',
    url: 'https://internetdb.shodan.io/',
    // InternetDB is the one with terms worth surfacing: free for
    // non-commercial use with attribution. Declaring it means the obligations
    // panel updates in response to a lookup a person just ran, which is the
    // licence machinery demonstrating itself.
    license: 'Mixed: mostly public/free APIs; Shodan InternetDB is non-commercial with attribution',
    spdx: 'NOASSERTION',
    attribution: 'DNS by Google Public DNS; RDAP via rdap.org; AS data from RIPE NCC; host index from Shodan InternetDB; CVE records from MITRE',
    shareAlike: false,
    nonCommercial: true,
    typicalMs: 500,
  },

  celestrak: {
    id: 10,
    key: 'celestrak',
    name: 'CelesTrak — orbital element sets',
    url: 'https://celestrak.org/',
    license: 'Free redistribution with attribution',
    spdx: 'NOASSERTION',
    attribution: 'Orbital data from CelesTrak (T.S. Kelso)',
    shareAlike: false,
    nonCommercial: false,
    typicalMs: 900,
  },

  nws: {
    id: 9,
    key: 'nws',
    name: 'NOAA / National Weather Service',
    url: 'https://api.weather.gov/',
    license: 'Public domain (US Government work)',
    spdx: 'CC-PDDC',
    attribution: 'NOAA National Weather Service',
    shareAlike: false,
    nonCommercial: false,
    typicalMs: 700,
  },

  // Two entries, not one, even though both read the same committed file: `key`
  // is how a FeedStatus finds its licence AND how the scheduler tracks a fetch,
  // so two specs sharing a key would collide in both. They are also genuinely
  // two datasets — a berth and a strait are not the same kind of object.
  ports: {
    id: 7,
    key: 'ports',
    name: 'PARALLAX curated port reference',
    url: 'https://github.com/ethan-goldstein/parallax',
    // Two things with two licences. The SELECTION — which ports and which
    // chokepoints are worth drawing — is authored here. The COORDINATES are
    // resolved from OpenStreetMap and each carries the OSM element id, so ODbL
    // applies and share-alike is real. Claiming CC0 over the whole thing would
    // be claiming a licence over somebody else's data.
    license: 'Selection authored here (CC0); coordinates from OpenStreetMap (ODbL)',
    spdx: 'CC0-1.0 AND ODbL-1.0',
    attribution: 'PARALLAX curated selection; coordinates © OpenStreetMap contributors (ODbL)',
    shareAlike: true,
    nonCommercial: false,
    typicalMs: 20,
  },

  chokepoints: {
    id: 8,
    key: 'chokepoints',
    name: 'PARALLAX curated chokepoint reference',
    url: 'https://github.com/ethan-goldstein/parallax',
    // Two things with two licences. The SELECTION — which ports and which
    // chokepoints are worth drawing — is authored here. The COORDINATES are
    // resolved from OpenStreetMap and each carries the OSM element id, so ODbL
    // applies and share-alike is real. Claiming CC0 over the whole thing would
    // be claiming a licence over somebody else's data.
    license: 'Selection authored here (CC0); coordinates from OpenStreetMap (ODbL)',
    spdx: 'CC0-1.0 AND ODbL-1.0',
    attribution: 'PARALLAX curated selection; coordinates © OpenStreetMap contributors (ODbL)',
    shareAlike: true,
    nonCommercial: false,
    typicalMs: 20,
  },

  usgs: {
    id: 0,
    key: 'usgs',
    name: 'USGS Earthquake Hazards Program',
    url: 'https://earthquake.usgs.gov/earthquakes/feed/',
    license: 'Public domain (US Government work)',
    spdx: 'CC-PDDC',
    attribution: 'U.S. Geological Survey',
    shareAlike: false,
    nonCommercial: false,
    typicalMs: 400,
  },

  emsc: {
    id: 3,
    key: 'emsc',
    name: 'EMSC — European-Mediterranean Seismological Centre',
    url: 'https://www.seismicportal.eu/',
    license: 'Open data, attribution requested',
    spdx: 'NOASSERTION',
    attribution: 'European-Mediterranean Seismological Centre (EMSC)',
    shareAlike: false,
    nonCommercial: false,
    typicalMs: 1800,
  },

  digitraffic: {
    id: 1,
    key: 'digitraffic',
    name: 'Fintraffic / Digitraffic Marine AIS',
    url: 'https://www.digitraffic.fi/en/marine-traffic/',
    license: 'CC BY 4.0',
    spdx: 'CC-BY-4.0',
    // CC BY requires naming the source; this exact string is what the UI shows.
    attribution: 'Traffic Management Finland / digitraffic.fi, CC BY 4.0',
    shareAlike: false,
    nonCommercial: false,
    typicalMs: 600,
  },

  airplanes_live: {
    id: 2,
    key: 'airplanes_live',
    name: 'airplanes.live',
    url: 'https://airplanes.live/',
    // Community feed with informal terms rather than a published SPDX license.
    // Saying so is better than picking a plausible-looking license it does not
    // actually carry.
    license: 'Community terms (non-commercial use, attribution requested)',
    spdx: 'NOASSERTION',
    attribution: 'Data from airplanes.live',
    shareAlike: false,
    nonCommercial: true,
    typicalMs: 600,
  },

  eonet: {
    id: 4,
    key: 'eonet',
    name: 'NASA EONET — Earth Observatory Natural Event Tracker',
    url: 'https://eonet.gsfc.nasa.gov/',
    license: 'Public domain (US Government work)',
    spdx: 'CC-PDDC',
    attribution: 'NASA Earth Observatory Natural Event Tracker',
    shareAlike: false,
    nonCommercial: false,
    typicalMs: 700,
  },

  gdacs: {
    id: 5,
    key: 'gdacs',
    name: 'GDACS — Global Disaster Alert and Coordination System',
    url: 'https://www.gdacs.org/',
    // EC reuse policy: free reuse with attribution, commercial included.
    license: 'EC public sector information, attribution required',
    spdx: 'NOASSERTION',
    attribution: 'GDACS — European Commission JRC and UN OCHA',
    shareAlike: false,
    nonCommercial: false,
    typicalMs: 1200,
  },

  swpc: {
    id: 6,
    key: 'swpc',
    name: 'NOAA Space Weather Prediction Center — OVATION aurora model',
    url: 'https://www.swpc.noaa.gov/',
    license: 'Public domain (US Government work)',
    spdx: 'CC-PDDC',
    attribution: 'NOAA Space Weather Prediction Center',
    shareAlike: false,
    nonCommercial: false,
    typicalMs: 1500,
  },
}

export const SOURCE_BY_ID: SourceMeta[] = Object.values(SOURCES).sort((a, b) => a.id - b.id)

/**
 * Obligations attached to a set of sources.
 *
 * Phase 7 turns this into a panel that fires before an export. Even now it is
 * the honest answer to "can I use this data for X", which is a question the
 * reference site never asks.
 */
export function licenseObligations(sourceIds: readonly number[]): string[] {
  const notes: string[] = []
  const used = SOURCE_BY_ID.filter((s) => sourceIds.includes(s.id))

  // Deduped by attribution TEXT, not by source. Two sources can share one
  // credit — the ports and chokepoint datasets are two feeds out of one authored
  // file — and naming that credit twice reads as a bug in the panel whose whole
  // job is to be precise about credit.
  const attributed = [
    ...new Set(used.filter((s) => s.spdx !== 'CC-PDDC').map((s) => s.attribution)),
  ]
  if (attributed.length > 0) {
    notes.push(`Attribution required: ${attributed.join('; ')}`)
  }
  const sa = used.filter((s) => s.shareAlike)
  if (sa.length > 0) {
    notes.push(`Share-alike — derived works inherit the license: ${sa.map((s) => s.name).join(', ')}`)
  }
  const nc = used.filter((s) => s.nonCommercial)
  if (nc.length > 0) {
    notes.push(`Non-commercial only: ${nc.map((s) => s.name).join(', ')}`)
  }
  return notes
}
