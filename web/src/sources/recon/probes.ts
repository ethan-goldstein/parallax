// ── web/src/sources/recon/probes.ts ─────────────────────────────────────────
// Network lookups a person runs by hand, from the browser, with no backend.
//
// ── why these are FACTS and not a side panel ────────────────────────────────
//
// The obvious build is a panel that fetches, renders, and forgets. This does not
// do that: every lookup is normalised into facts and committed through the same
// Ingestor as every feed, for four reasons in descending order of force.
//
// 1. The engine already does exactly this to itself. `Session::record_audit`
//    writes every policy decision into the store as ordinary facts, and
//    policy.hpp argues at length for why. If the system's own decisions are
//    facts, a DNS answer certainly is. An ephemeral panel would be a second,
//    unaudited data path through an application whose entire claim is that there
//    is one.
//
// 2. A lookup is the cleanest bitemporal object here. DNS returns a TTL — an
//    explicit validity interval with a stated end, not one inferred from a
//    heuristic. RDAP returns registration and expiry dates. Look a domain up
//    twice an hour apart, get a different A record, and the scrubber shows the
//    change on the system axis with both values in the inspector's history. That
//    is the project's thesis demonstrated on data the VISITOR generated, which
//    is more convincing than any feed.
//
// 3. It fills the `network` category honestly, rather than leaving it empty.
//
// 4. Every lookup passes through the policy engine and lands in the audit log —
//    the same log the engine tab is displaying while you use this.
//
// ── the boundary, stated once ───────────────────────────────────────────────
//
// RDAP returns registrant name, email, address and phone for many domains.
// NONE of it is ingested. It is dropped in the adapter, before the store, not
// filtered at query time — the stronger of the two claims, and the one worth
// making. README.md notes that `Sensitivity.PersonLinked` exists precisely to
// name the category this project refuses to collect; this is where that refusal
// actually happens.
//
// No port scanning: a browser cannot open arbitrary sockets, and this would
// decline to be a scanning tool if it could. No IP geolocation: see
// countries.ts. No certificate-transparency enumeration: crt.sh does not send
// CORS headers, so it is unreachable from a static page and is not worth a proxy.
// ────────────────────────────────────────────────────────────────────────────
import { Sensitivity, type AttrDecl } from '../spec'
import { centroidFor } from './countries'

/**
 * Attributes a lookup writes.
 *
 * Declared here and registered explicitly, because the probes are deliberately
 * NOT in SOURCE_SPECS — they have no unattended fetch, and putting them there
 * would drag them into the boot cycle and the poll scheduler, where a lookup
 * nobody asked for would run on a timer.
 *
 * `recon_label` is Public and `recon_position` is Public because neither carries
 * anything about a person: identity fields never reach a fact (see the boundary
 * note above), and the position is a country centroid from a registry entry.
 */
export const RECON_ATTRIBUTES: readonly AttrDecl[] = [
  { name: 'recon_position', sensitivity: Sensitivity.Public },
  { name: 'recon_label', sensitivity: Sensitivity.Public },
]

export type ProbeId = 'dns' | 'rdap' | 'asn' | 'exposure' | 'cve'

export interface ProbeField {
  label: string
  value: string
  /** Rendered in the denial colour — an exposed service, a sanctioned entry. */
  warn?: boolean
}

export interface ProbeResult {
  probe: ProbeId
  /** What was asked about, normalised. Becomes part of the entity key. */
  subject: string
  fields: ProbeField[]
  /** Where to place it, if anywhere. */
  position: { lat: number; lon: number; note: string } | null
  /**
   * Validity of this answer, in unix seconds.
   *
   * DNS states it outright as a TTL. Everything else gets a stated, bounded
   * window rather than OPEN_VALID: asserting that a WHOIS record is true forever
   * would be exactly the overclaim the rest of this codebase refuses.
   */
  validFromUnix: number
  validToUnix: number
}

export interface ProbeDef {
  id: ProbeId
  label: string
  placeholder: string
  /** One line, shown under the input, saying what this actually asks. */
  hint: string
  run: (input: string, signal?: AbortSignal) => Promise<ProbeResult>
}

const nowUnix = (): number => Math.floor(Date.now() / 1000)

/** Default validity for answers that do not carry one: fifteen minutes. */
const DEFAULT_TTL = 900

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, signal ? { signal } : {})
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

// ── DNS over HTTPS ──────────────────────────────────────────────────────────

const DNS_TYPES = ['A', 'AAAA', 'MX', 'NS', 'TXT'] as const

async function dns(input: string, signal?: AbortSignal): Promise<ProbeResult> {
  const name = input.trim().replace(/^https?:\/\//, '').split('/')[0] ?? input
  const answers = await Promise.all(
    DNS_TYPES.map(async (t) => {
      const body = (await getJson(
        `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${t}`,
        signal,
      )) as { Answer?: { data?: unknown; TTL?: unknown; type?: unknown }[] }
      return { type: t, answers: body.Answer ?? [] }
    }),
  )

  const fields: ProbeField[] = []
  // The smallest TTL across every record is when this whole answer stops being
  // reliable, so it is what the fact's validity window uses.
  let minTtl = Number.POSITIVE_INFINITY

  for (const { type, answers: rows } of answers) {
    for (const r of rows) {
      const data = str(r.data)
      if (!data) continue
      if (typeof r.TTL === 'number' && r.TTL > 0) minTtl = Math.min(minTtl, r.TTL)
      fields.push({ label: type, value: data })
    }
  }

  if (fields.length === 0) fields.push({ label: 'result', value: 'no records' })

  const t = nowUnix()
  const ttl = Number.isFinite(minTtl) ? minTtl : DEFAULT_TTL
  return {
    probe: 'dns',
    subject: name,
    fields: [{ label: 'ttl', value: `${ttl}s` }, ...fields],
    // A name has no location. Placement, if any, comes from the ASN probe.
    position: null,
    validFromUnix: t,
    validToUnix: t + ttl,
  }
}

// ── RDAP (the successor to WHOIS) ───────────────────────────────────────────

/**
 * Registrant identity is discarded here, in the adapter.
 *
 * Every vCard entry naming a person, an email, a postal address or a phone
 * number is dropped before a fact is built. Only the abuse contact — which
 * exists to be published and is an operational address, not a personal one —
 * and the lifecycle dates survive.
 */
const ALLOWED_VCARD = new Set(['fn'])

async function rdap(input: string, signal?: AbortSignal): Promise<ProbeResult> {
  const domain = input.trim().replace(/^https?:\/\//, '').split('/')[0] ?? input
  const body = (await getJson(
    `https://rdap.org/domain/${encodeURIComponent(domain)}`,
    signal,
  )) as {
    ldhName?: unknown
    status?: unknown
    events?: { eventAction?: unknown; eventDate?: unknown }[]
    entities?: { roles?: unknown; vcardArray?: unknown }[]
  }

  const fields: ProbeField[] = []
  fields.push({ label: 'domain', value: str(body.ldhName) || domain })

  if (Array.isArray(body.status) && body.status.length > 0) {
    fields.push({ label: 'status', value: (body.status as string[]).join(', ') })
  }

  for (const e of body.events ?? []) {
    const action = str(e.eventAction)
    const date = str(e.eventDate)
    if (!action || !date) continue
    if (!['registration', 'expiration', 'last changed'].includes(action)) continue
    fields.push({ label: action, value: date.slice(0, 10) })
  }

  // Abuse contact only, and only its name — never the registrant's.
  let dropped = 0
  for (const ent of body.entities ?? []) {
    const roles = Array.isArray(ent.roles) ? (ent.roles as string[]) : []
    const isAbuse = roles.includes('abuse')
    const card = Array.isArray(ent.vcardArray) ? (ent.vcardArray as unknown[])[1] : null
    if (!Array.isArray(card)) continue
    for (const entry of card as unknown[][]) {
      const key = str(entry?.[0])
      const value = str(entry?.[3])
      if (!key || !value) continue
      if (isAbuse && ALLOWED_VCARD.has(key)) {
        fields.push({ label: 'abuse contact', value })
      } else if (['fn', 'email', 'tel', 'adr'].includes(key)) {
        dropped++
      }
    }
  }

  if (dropped > 0) {
    fields.push({
      label: 'discarded',
      value: `${dropped} registrant identity field(s), dropped before the store`,
    })
  }

  const t = nowUnix()
  return {
    probe: 'rdap',
    subject: domain,
    fields,
    position: null,
    validFromUnix: t,
    // Registry records change on the order of days; an hour is a bound, not a
    // guess dressed as one.
    validToUnix: t + 3600,
  }
}

// ── autonomous system, via RIPEstat ─────────────────────────────────────────

async function asn(input: string, signal?: AbortSignal): Promise<ProbeResult> {
  const resource = input.trim().replace(/^as/i, '')
  // Two calls, because neither endpoint answers both halves. `as-overview` has
  // the holder and the allocation block; the registered country lives only in
  // the whois record, and `as-overview`'s holder string does NOT reliably carry
  // it — "GOOGLE - Google LLC" has no country in it at all, which is how the
  // first version of this ended up never placing anything on the map.
  const [overview, whois] = await Promise.all([
    getJson(
      `https://stat.ripe.net/data/as-overview/data.json?resource=AS${encodeURIComponent(resource)}`,
      signal,
    ) as Promise<{ data?: { holder?: unknown; resource?: unknown; block?: { name?: unknown } } }>,
    // Optional: the country is a nice-to-have, and a whois outage should not
    // fail a lookup whose main answer already arrived.
    (getJson(
      `https://stat.ripe.net/data/whois/data.json?resource=AS${encodeURIComponent(resource)}`,
      signal,
    ) as Promise<{ data?: { records?: { key?: unknown; value?: unknown }[][] } }>).catch(
      () => null,
    ),
  ])

  const holder = str(overview.data?.holder)
  const fields: ProbeField[] = [
    { label: 'as', value: `AS${str(overview.data?.resource) || resource}` },
    { label: 'holder', value: holder || 'unknown' },
  ]

  const blockName = str(overview.data?.block?.name)
  if (blockName) fields.push({ label: 'block', value: blockName })

  // The registry's own `country:` attribute. Case varies by RIR — ARIN returns
  // "Country", RIPE and APNIC "country" — so the key is matched case-insensitively.
  let cc: string | null = null
  for (const group of whois?.data?.records ?? []) {
    for (const entry of group) {
      if (str(entry.key).toLowerCase() !== 'country') continue
      const v = str(entry.value).trim().toUpperCase()
      if (/^[A-Z]{2}$/.test(v)) {
        cc = v
        break
      }
    }
    if (cc) break
  }

  const centroid = centroidFor(cc)
  fields.push({ label: 'registered in', value: cc ?? 'not stated by the registry' })

  const t = nowUnix()
  return {
    probe: 'asn',
    subject: `AS${resource}`,
    fields,
    position: centroid
      ? {
          lat: centroid[0],
          lon: centroid[1],
          note: 'registered country of the announcing AS — not a location claim about any host',
        }
      : null,
    validFromUnix: t,
    validToUnix: t + 3600,
  }
}

// ── host exposure, via Shodan InternetDB ────────────────────────────────────

async function exposure(input: string, signal?: AbortSignal): Promise<ProbeResult> {
  const ip = input.trim()
  const res = await fetch(`https://internetdb.shodan.io/${encodeURIComponent(ip)}`, {
    ...(signal ? { signal } : {}),
  })
  // InternetDB answers 404 for a host it has never seen, which is information
  // rather than an error.
  if (res.status === 404) {
    const t = nowUnix()
    return {
      probe: 'exposure',
      subject: ip,
      fields: [{ label: 'result', value: 'no record — this host is not in the index' }],
      position: null,
      validFromUnix: t,
      validToUnix: t + DEFAULT_TTL,
    }
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)

  const body = (await res.json()) as {
    ports?: unknown
    hostnames?: unknown
    tags?: unknown
    vulns?: unknown
    cpes?: unknown
  }

  const fields: ProbeField[] = []
  const ports = Array.isArray(body.ports) ? body.ports : []
  fields.push({ label: 'open ports', value: ports.length ? ports.join(', ') : 'none indexed' })

  const hostnames = Array.isArray(body.hostnames) ? body.hostnames : []
  if (hostnames.length) fields.push({ label: 'hostnames', value: hostnames.join(', ') })

  const tags = Array.isArray(body.tags) ? body.tags : []
  if (tags.length) fields.push({ label: 'tags', value: tags.join(', ') })

  const vulns = Array.isArray(body.vulns) ? (body.vulns as string[]) : []
  if (vulns.length) {
    fields.push({ label: 'known cves', value: vulns.join(', '), warn: true })
  }

  const t = nowUnix()
  return {
    probe: 'exposure',
    subject: ip,
    fields,
    position: null,
    validFromUnix: t,
    validToUnix: t + 3600,
  }
}

// ── CVE, from the MITRE authority ───────────────────────────────────────────

async function cve(input: string, signal?: AbortSignal): Promise<ProbeResult> {
  const id = input.trim().toUpperCase()
  if (!/^CVE-\d{4}-\d{4,}$/.test(id)) {
    throw new Error('expected an identifier of the form CVE-2021-44228')
  }

  const body = (await getJson(`https://cveawg.mitre.org/api/cve/${id}`, signal)) as {
    cveMetadata?: { datePublished?: unknown; state?: unknown }
    containers?: {
      cna?: {
        descriptions?: { value?: unknown }[]
        metrics?: { cvssV3_1?: { baseScore?: unknown; baseSeverity?: unknown } }[]
      }
    }
  }

  const cna = body.containers?.cna
  const description = str(cna?.descriptions?.[0]?.value)
  const metric = cna?.metrics?.find((m) => m.cvssV3_1)?.cvssV3_1
  const score = typeof metric?.baseScore === 'number' ? metric.baseScore : null

  const fields: ProbeField[] = [{ label: 'cve', value: id }]
  if (body.cveMetadata?.state) fields.push({ label: 'state', value: str(body.cveMetadata.state) })
  if (score !== null) {
    fields.push({
      label: 'cvss v3.1',
      value: `${score} ${str(metric?.baseSeverity)}`.trim(),
      warn: score >= 7,
    })
  }
  if (body.cveMetadata?.datePublished) {
    fields.push({ label: 'published', value: str(body.cveMetadata.datePublished).slice(0, 10) })
  }
  if (description) fields.push({ label: 'summary', value: description.slice(0, 400) })

  const t = nowUnix()
  return {
    probe: 'cve',
    subject: id,
    fields,
    position: null,
    validFromUnix: t,
    // A published CVE record is about as stable as anything here gets.
    validToUnix: t + 86_400,
  }
}

export const PROBES: readonly ProbeDef[] = [
  {
    id: 'dns',
    label: 'dns',
    placeholder: 'example.com',
    hint: 'A, AAAA, MX, NS and TXT over DNS-over-HTTPS. The answer carries a TTL — a real validity interval, stated by the source.',
    run: dns,
  },
  {
    id: 'rdap',
    label: 'whois',
    placeholder: 'example.com',
    hint: 'Registry record over RDAP. Registrant name, email, address and phone are discarded in the adapter, before the store.',
    run: rdap,
  },
  {
    id: 'asn',
    label: 'asn',
    placeholder: '15169',
    hint: 'Autonomous system holder and registered country, from RIPEstat. Placed at the country centroid — a registry fact, not geolocation.',
    run: asn,
  },
  {
    id: 'exposure',
    label: 'exposure',
    placeholder: '8.8.8.8',
    hint: 'Ports and services already indexed by Shodan InternetDB. This reads a public index; it does not scan anything.',
    run: exposure,
  },
  {
    id: 'cve',
    label: 'cve',
    placeholder: 'CVE-2021-44228',
    hint: 'The published record from the MITRE CVE authority.',
    run: cve,
  },
]
