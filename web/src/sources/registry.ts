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

  const attributed = used.filter((s) => s.spdx !== 'CC-PDDC')
  if (attributed.length > 0) {
    notes.push(`Attribution required: ${attributed.map((s) => s.attribution).join('; ')}`)
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
