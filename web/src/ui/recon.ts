// ── web/src/ui/recon.ts ─────────────────────────────────────────────────────
// The RECON tab: network lookups, run by hand, committed to the store.
//
// The interesting part is not the fetching — see sources/recon/probes.ts for the
// argument about why every answer becomes facts. This file is the surface: a
// probe picker, one input, the answer, and the honest list of what it refuses.
//
// The "recent" list is the demonstration. Look the same domain up twice with a
// gap and there are two entries, two transactions, and — if the answer changed —
// two versions of one entity that the inspector will show you side by side. It
// is the project's thesis running on data the visitor produced themselves.
// ────────────────────────────────────────────────────────────────────────────
import { Kind, toTimestamp, writeGeo, writeSymBits } from '../engine/abi'
import { SOURCES } from '../sources/registry'
import { PROBES, type ProbeDef, type ProbeResult } from '../sources/recon/probes'
import type { Batch, EntityRegistry } from '../sources/batch'

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )
}

export interface ReconAttrs {
  position: number
  label: number
}

/**
 * One lookup → one batch.
 *
 * System time is NOW, and legitimately so: unlike a feed with its own revision
 * stamp, the moment this client asked IS when this knowledge entered the store.
 * That is the honest reading of the system axis for an interactive query.
 *
 * The entity is keyed on (probe, subject) so asking the same question twice
 * writes two versions of ONE entity rather than two unrelated ones — which is
 * the entire point of routing this through the store.
 */
export function buildReconBatch(
  result: ProbeResult,
  registry: EntityRegistry,
  attrs: ReconAttrs,
  intern: (text: string) => number,
): Batch {
  const entity = registry.idFor(`recon:${result.probe}:${result.subject}`)
  const validFrom = toTimestamp(result.validFromUnix)
  const validTo = toTimestamp(result.validToUnix)
  const facts: Batch['facts'] = []

  if (result.position) {
    const { lat, lon } = result.position
    facts.push({
      entity,
      attr: attrs.position,
      kind: Kind.Geo,
      validFrom,
      validTo,
      source: SOURCES.recon!.id,
      writePayload: (v, off) => writeGeo(v, off, lat, lon),
    })
  }

  // The answer, flattened to one summary line. Individual fields are shown in
  // the panel; the store keeps what identifies this version of the answer, which
  // is what makes a CHANGE between two lookups visible in the inspector.
  const summary = result.fields
    .filter((f) => f.label !== 'discarded')
    .map((f) => `${f.label}: ${f.value}`)
    .join(' · ')
    .slice(0, 300)

  facts.push({
    entity,
    attr: attrs.label,
    kind: Kind.Sym,
    validFrom,
    validTo,
    source: SOURCES.recon!.id,
    writePayload: (v, off) => writeSymBits(v, off, intern(`${result.subject} — ${summary}`)),
  })

  return { wallClockUnix: Math.floor(Date.now() / 1000), facts }
}

export interface ReconOptions {
  host: HTMLElement
  /** Commits the batch and refreshes the map. Returns facts actually stored. */
  onResult: (result: ProbeResult) => { committed: number; duplicates: number }
  /** Flies the globe to a placed result. */
  onLocate: (lat: number, lon: number) => void
}

interface HistoryEntry {
  probe: string
  subject: string
  at: number
  stored: number
}

export class ReconPanel {
  #opts: ReconOptions
  #probe: ProbeDef = PROBES[0]!
  #history: HistoryEntry[] = []
  #busy = false
  #last: ProbeResult | null = null
  #error: string | null = null

  constructor(opts: ReconOptions) {
    this.#opts = opts
    this.#render()
  }

  async #run(input: string): Promise<void> {
    if (this.#busy || input.trim().length === 0) return
    this.#busy = true
    this.#error = null
    this.#render()

    try {
      const result = await this.#probe.run(input)
      const { committed } = this.#opts.onResult(result)
      this.#last = result
      this.#history.unshift({
        probe: this.#probe.label,
        subject: result.subject,
        at: Date.now(),
        stored: committed,
      })
      this.#history = this.#history.slice(0, 8)
    } catch (err) {
      this.#last = null
      this.#error = err instanceof Error ? err.message : String(err)
    } finally {
      this.#busy = false
      this.#render()
    }
  }

  #render(): void {
    const p = this.#probe
    const r = this.#last

    this.#opts.host.innerHTML = `
      <div class="qb-sec">
        <div class="hud-label qb-legend">look up</div>
        <div class="qb-seg" data-role="probe">
          ${PROBES.map(
            (x) =>
              `<button type="button" data-probe="${x.id}" class="${
                x.id === p.id ? 'on' : ''
              }">${escapeHtml(x.label)}</button>`,
          ).join('')}
        </div>
        <div class="rc-hint">${escapeHtml(p.hint)}</div>
        <div class="rc-input">
          <input type="text" class="rc-q" spellcheck="false" autocomplete="off"
                 placeholder="${escapeHtml(p.placeholder)}" ${this.#busy ? 'disabled' : ''} />
          <button type="button" class="rc-go" ${this.#busy ? 'disabled' : ''}>${
            this.#busy ? '…' : 'run'
          }</button>
        </div>
      </div>

      ${
        this.#error
          ? `<div class="qb-sec"><div class="rc-error">${escapeHtml(this.#error)}</div></div>`
          : ''
      }

      ${
        r
          ? `<div class="qb-sec">
               <div class="hud-label qb-legend">answer</div>
               ${r.fields
                 .map(
                   (f) => `<div class="rc-row${f.warn ? ' warn' : ''}">
                       <span class="hud-label">${escapeHtml(f.label)}</span>
                       <span>${escapeHtml(f.value)}</span>
                     </div>`,
                 )
                 .join('')}
               <div class="rc-valid">
                 valid until ${new Date(r.validToUnix * 1000).toISOString().replace('T', ' ').slice(0, 16)}Z
                 — this answer has an expiry, and the store knows it
               </div>
               ${
                 r.position
                   ? `<button type="button" class="rc-locate">show on map</button>
                      <div class="rc-note">${escapeHtml(r.position.note)}</div>`
                   : `<div class="rc-note">not placed on the map — nothing here is a location</div>`
               }
             </div>`
          : ''
      }

      ${
        this.#history.length > 0
          ? `<div class="qb-sec">
               <div class="hud-label qb-legend">this session</div>
               ${this.#history
                 .map(
                   (h) => `<div class="rc-hist">
                       <span>${escapeHtml(h.probe)} ${escapeHtml(h.subject)}</span>
                       <span class="rc-hist-n">${h.stored > 0 ? `+${h.stored} txn` : 'no change'}</span>
                     </div>`,
                 )
                 .join('')}
               <div class="rc-note">
                 Ask the same thing twice. If the answer changed, the store holds both
                 versions — click the point and the inspector shows them in order.
               </div>
             </div>`
          : ''
      }

      <div class="qb-sec rc-refuses">
        <div class="hud-label qb-legend">what this deliberately does not do</div>
        <div class="rc-note">
          <strong>No port scanning.</strong> A browser cannot open arbitrary sockets, and
          this would decline to be a scanning tool if it could. The exposure probe reads
          an index somebody else already built.
        </div>
        <div class="rc-note">
          <strong>No registrant identity.</strong> RDAP returns names, emails and postal
          addresses. They are discarded in the adapter, before the store — not filtered
          out at query time, which would be the weaker claim.
        </div>
        <div class="rc-note">
          <strong>No IP geolocation.</strong> Results are placed at the registered country
          of the announcing AS, which is a fact about a registry entry. IP geolocation is
          wrong often enough that plotting it would be an overclaim.
        </div>
      </div>
    `

    const host = this.#opts.host
    host.querySelectorAll<HTMLButtonElement>('[data-probe]').forEach((b) => {
      b.addEventListener('click', () => {
        const next = PROBES.find((x) => x.id === b.dataset.probe)
        if (!next || next.id === this.#probe.id) return
        this.#probe = next
        this.#last = null
        this.#error = null
        this.#render()
      })
    })

    const input = host.querySelector<HTMLInputElement>('.rc-q')
    const go = (): void => void this.#run(input?.value ?? '')
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        go()
      }
    })
    host.querySelector<HTMLButtonElement>('.rc-go')?.addEventListener('click', go)

    host.querySelector<HTMLButtonElement>('.rc-locate')?.addEventListener('click', () => {
      if (r?.position) this.#opts.onLocate(r.position.lat, r.position.lon)
    })
  }
}
