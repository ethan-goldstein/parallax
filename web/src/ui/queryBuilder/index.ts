// ── web/src/ui/queryBuilder/index.ts ────────────────────────────────────────
// Plain-English controls that write the query language in front of you.
//
// What was here before was a text box, centred over the map, in the position and
// shape of a search field — placeholder `earthquakes where magnitude > 4.5`. A
// visitor who has never seen this grammar has two options at that box: type a
// place name and get a parse error, or leave. Neither of those shows off a query
// planner.
//
// The controls are generated from `LayerDef.filters`, not written per layer, so
// the builder can only offer fields the store actually has. It cannot express a
// query the planner would silently match nothing for, which removes a whole
// category of "it returned zero rows and I don't know why".
//
// ── the compiled query is the feature ───────────────────────────────────────
//
// The output line is not a debug affordance. It is the thing being demonstrated:
// drag a slider, watch `where magnitude > 4.5` appear, click EDIT AS TEXT and
// the same string is sitting in a console you can now extend by hand. The
// builder teaches the language rather than replacing it.
//
// The two time axes are deliberately NOT controls here. They belong to the
// scrubber, and duplicating them would give a viewer two places to set one
// thing. The output shows where the scrubber has them, labelled as such.
// ────────────────────────────────────────────────────────────────────────────
import { fromTimestamp } from '../../engine/abi'
import type { CmpOp, FilterField, LayerDef } from '../../sources/spec'
import { compile, type FilterClause, type QuerySpec } from './compile'

const NUMERIC_OPS: readonly CmpOp[] = ['>', '>=', '<', '<=', '=', '!=']

const WINDOWS: readonly { label: string; value: string | null }[] = [
  { label: 'any', value: null },
  { label: '1h', value: '-1h' },
  { label: '6h', value: '-6h' },
  { label: '24h', value: '-24h' },
  { label: '7d', value: '-7d' },
]

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )
}

export interface QueryBuilderOptions {
  host: HTMLElement
  layers: readonly LayerDef[]
  /** Runs the compiled text. */
  onRun: (sql: string) => void
  /** Hands the compiled text to the raw console. */
  onEdit: (sql: string) => void
  /** Arms map-click capture for the spatial control; resolves with a point. */
  onPickPoint: (cb: (lat: number, lon: number) => void) => void
}

interface BuilderState {
  layer: LayerDef
  filters: FilterClause[]
  spatial: 'off' | 'near'
  lat: number
  lon: number
  radiusKm: number
  since: string | null
  orderField: string | null
  orderDesc: boolean
  limit: number | null
}

/** Every field this layer can be filtered or sorted on. */
function fieldsFor(layer: LayerDef): readonly FilterField[] {
  if (layer.filters?.length) return layer.filters
  // A layer that declares nothing still has its scalar, which is always
  // filterable — so a newly registered layer works before anyone describes it.
  const fallback: FilterField = {
    attr: layer.scalarAttr,
    label: layer.scalarAttr.replace(/_/g, ' '),
    kind: 'number',
    min: layer.visual.rampLow,
    max: layer.visual.rampHigh,
  }
  // Assigned conditionally rather than as `unit: layer.scalarUnit`: under
  // exactOptionalPropertyTypes an explicit `undefined` is not the same as absent.
  if (layer.scalarUnit !== undefined) fallback.unit = layer.scalarUnit
  return [fallback]
}

export class QueryBuilder {
  #opts: QueryBuilderOptions
  #state: BuilderState
  #root: HTMLElement

  constructor(opts: QueryBuilderOptions) {
    this.#opts = opts
    this.#state = this.#initialFor(opts.layers[0]!)
    this.#root = document.createElement('div')
    this.#root.className = 'qb'
    opts.host.appendChild(this.#root)
    this.#renderAll()
  }

  /** The text the controls currently describe. */
  get sql(): string {
    return compile(this.#spec()).text
  }

  /** Redraws the temporal footer. Called when the scrubber moves. */
  setTemporal(validAt: number, sysAt: number, txnCount: number): void {
    const el = this.#root.querySelector('.qb-when')
    if (!el) return
    const iso = new Date(fromTimestamp(validAt) * 1000).toISOString().replace('T', ' ').slice(0, 16)
    el.innerHTML =
      `<span class="hud-label">as of</span>` +
      `<span class="qb-valid">${iso}Z</span>` +
      `<span class="hud-label">as known at</span>` +
      `<span class="qb-sys">txn ${sysAt} / ${Math.max(0, txnCount - 1)}</span>` +
      `<span class="qb-from">— from the scrubber, not this panel</span>`
  }

  #initialFor(layer: LayerDef): BuilderState {
    const hint = layer.spatialHint
    return {
      layer,
      filters: [],
      spatial: 'off',
      lat: hint?.examplePoint?.[0] ?? 0,
      lon: hint?.examplePoint?.[1] ?? 0,
      radiusKm: hint?.defaultRadiusKm ?? 200,
      since: null,
      orderField: null,
      orderDesc: true,
      limit: null,
    }
  }

  #spec(): QuerySpec {
    const s = this.#state
    return {
      source: s.layer.qlNames[0]!,
      filters: s.filters,
      spatial:
        s.spatial === 'near'
          ? { kind: 'near', lat: s.lat, lon: s.lon, radiusKm: s.radiusKm }
          : null,
      since: s.since,
      order: s.orderField ? { field: s.orderField, desc: s.orderDesc } : null,
      limit: s.limit,
    }
  }

  // ── rendering ────────────────────────────────────────────────────────────

  #renderAll(): void {
    const s = this.#state
    const fields = fieldsFor(s.layer)
    const hint = s.layer.spatialHint

    this.#root.innerHTML = `
      <div class="qb-sec">
        <div class="hud-label qb-legend">show me</div>
        <div class="qb-seg" data-role="layer">
          ${this.#opts.layers
            .map(
              (l) =>
                `<button type="button" data-qb-layer="${escapeHtml(l.name)}"
                         class="${l.name === s.layer.name ? 'on' : ''}">${escapeHtml(
                           l.qlNames[0]!,
                         )}</button>`,
            )
            .join('')}
        </div>
      </div>

      <div class="qb-sec">
        <div class="hud-label qb-legend">where</div>
        <div class="qb-filters"></div>
        <button type="button" class="qb-add"
                ${fields.length === 0 ? 'disabled' : ''}>+ add a condition</button>
      </div>

      <div class="qb-sec">
        <div class="hud-label qb-legend">near</div>
        <div class="qb-seg" data-role="spatial">
          <button type="button" data-spatial="off" class="${
            s.spatial === 'off' ? 'on' : ''
          }">anywhere</button>
          <button type="button" data-spatial="near" class="${
            s.spatial === 'near' ? 'on' : ''
          }">a point</button>
        </div>
        <div class="qb-near" ${s.spatial === 'near' ? '' : 'hidden'}>
          <div class="qb-coords">
            <label class="hud-label">lat<input type="number" class="qb-lat" step="0.01"
                   value="${s.lat}" /></label>
            <label class="hud-label">lon<input type="number" class="qb-lon" step="0.01"
                   value="${s.lon}" /></label>
            <button type="button" class="qb-pick">pick on map</button>
          </div>
          <label class="qb-range hud-label">radius
            <input type="range" class="qb-radius" min="5" max="3000" step="5"
                   value="${s.radiusKm}" />
            <span class="qb-radius-out num">${s.radiusKm} km</span>
          </label>
          ${
            hint?.exampleLabel
              ? `<div class="qb-hint">default is ${escapeHtml(
                  hint.exampleLabel,
                )} — somewhere this layer actually has data</div>`
              : ''
          }
        </div>
      </div>

      <div class="qb-sec">
        <div class="hud-label qb-legend">valid within</div>
        <div class="qb-seg" data-role="since">
          ${WINDOWS.map(
            (w) =>
              `<button type="button" data-since="${w.value ?? ''}"
                       class="${s.since === w.value ? 'on' : ''}">${w.label}</button>`,
          ).join('')}
        </div>
      </div>

      <div class="qb-sec">
        <div class="hud-label qb-legend">sort</div>
        <div class="qb-sort">
          <select class="qb-order">
            <option value="">unsorted</option>
            ${fields
              .filter((f) => f.kind === 'number')
              .map(
                (f) =>
                  `<option value="${escapeHtml(f.attr)}" ${
                    s.orderField === f.attr ? 'selected' : ''
                  }>${escapeHtml(f.label)}</option>`,
              )
              .join('')}
          </select>
          <button type="button" class="qb-dir" ${s.orderField ? '' : 'disabled'}>${
            s.orderDesc ? 'desc' : 'asc'
          }</button>
          <label class="hud-label qb-limit-wrap">limit
            <input type="number" class="qb-limit" min="1" max="10000" placeholder="all"
                   value="${s.limit ?? ''}" />
          </label>
        </div>
      </div>

      <div class="qb-out">
        <div class="hud-label qb-legend">the query this wrote</div>
        <code class="qb-code"></code>
        <div class="qb-when"></div>
        <div class="qb-actions">
          <button type="button" class="qb-run">run</button>
          <button type="button" class="qb-edit">edit as text</button>
        </div>
      </div>
    `

    this.#renderFilters()
    this.#bind()
    this.#syncOutput()
  }

  #renderFilters(): void {
    const host = this.#root.querySelector<HTMLElement>('.qb-filters')
    if (!host) return
    const fields = fieldsFor(this.#state.layer)

    if (this.#state.filters.length === 0) {
      host.innerHTML = `<div class="qb-empty">everything on this layer</div>`
      return
    }

    host.innerHTML = this.#state.filters
      .map((c, i) => {
        const ops = c.field.ops ?? NUMERIC_OPS
        const value =
          c.field.kind === 'number'
            ? `<input type="range" data-i="${i}" class="qb-val-range"
                      min="${c.field.min ?? 0}" max="${c.field.max ?? 100}"
                      step="${c.field.step ?? 1}" value="${c.value}" />
               <span class="qb-val-out num" data-out="${i}">${c.value}${
                 c.field.unit ? ` ${escapeHtml(c.field.unit)}` : ''
               }</span>`
            : c.field.kind === 'enum'
              ? `<select data-i="${i}" class="qb-val-enum">${(c.field.options ?? [])
                  .map(
                    (o) =>
                      `<option value="${escapeHtml(o.value)}" ${
                        o.value === c.value ? 'selected' : ''
                      }>${escapeHtml(o.label)}</option>`,
                  )
                  .join('')}</select>`
              : `<input type="text" data-i="${i}" class="qb-val-text"
                        value="${escapeHtml(c.value)}" placeholder="text to match" />`

        return `<div class="qb-filter">
            <select data-i="${i}" class="qb-field">
              ${fields
                .map(
                  (f) =>
                    `<option value="${escapeHtml(f.attr)}" ${
                      f.attr === c.field.attr ? 'selected' : ''
                    }>${escapeHtml(f.label)}</option>`,
                )
                .join('')}
            </select>
            <select data-i="${i}" class="qb-op">
              ${ops
                .map(
                  (o) =>
                    `<option value="${o}" ${o === c.op ? 'selected' : ''}>${escapeHtml(
                      o,
                    )}</option>`,
                )
                .join('')}
            </select>
            <div class="qb-val">${value}</div>
            <button type="button" class="qb-del" data-i="${i}"
                    aria-label="remove condition">×</button>
          </div>`
      })
      .join('')

    this.#bindFilters()
  }

  // ── events ───────────────────────────────────────────────────────────────

  #bind(): void {
    const r = this.#root
    const q = <T extends HTMLElement>(sel: string): T | null => r.querySelector<T>(sel)

    // `data-qb-layer`, not `data-layer`: the layer panel's checkboxes already own
    // that attribute, and two controls sharing a selector is the kind of thing that
    // works until someone reaches for it from outside this file.
    r.querySelectorAll<HTMLButtonElement>('[data-qb-layer]').forEach((b) => {
      b.addEventListener('click', () => {
        const next = this.#opts.layers.find((l) => l.name === b.dataset.qbLayer)
        if (!next || next.name === this.#state.layer.name) return
        // Filters name attributes that belong to the old layer, so they cannot
        // survive the switch — carrying them over would emit `where speed > 4`
        // against earthquakes, which parses and matches nothing.
        this.#state = this.#initialFor(next)
        this.#renderAll()
      })
    })

    r.querySelectorAll<HTMLButtonElement>('[data-spatial]').forEach((b) => {
      b.addEventListener('click', () => {
        this.#state.spatial = b.dataset.spatial === 'near' ? 'near' : 'off'
        this.#renderAll()
      })
    })

    r.querySelectorAll<HTMLButtonElement>('[data-since]').forEach((b) => {
      b.addEventListener('click', () => {
        this.#state.since = b.dataset.since || null
        r.querySelectorAll('[data-since]').forEach((o) => o.classList.remove('on'))
        b.classList.add('on')
        this.#syncOutput()
      })
    })

    q<HTMLButtonElement>('.qb-add')?.addEventListener('click', () => {
      const field = fieldsFor(this.#state.layer)[0]
      if (!field) return
      this.#state.filters.push({
        field,
        op: (field.ops ?? NUMERIC_OPS)[0]!,
        value: field.kind === 'number' ? String(field.min ?? 0) : (field.options?.[0]?.value ?? ''),
      })
      this.#renderFilters()
      this.#syncOutput()
    })

    q<HTMLInputElement>('.qb-lat')?.addEventListener('input', (e) => {
      this.#state.lat = Number((e.target as HTMLInputElement).value)
      this.#syncOutput()
    })
    q<HTMLInputElement>('.qb-lon')?.addEventListener('input', (e) => {
      this.#state.lon = Number((e.target as HTMLInputElement).value)
      this.#syncOutput()
    })
    q<HTMLInputElement>('.qb-radius')?.addEventListener('input', (e) => {
      this.#state.radiusKm = Number((e.target as HTMLInputElement).value)
      const out = q('.qb-radius-out')
      if (out) out.textContent = `${this.#state.radiusKm} km`
      this.#syncOutput()
    })

    // Clicking the map to fill in a coordinate is the moment the whole panel
    // stops looking like a form and starts looking like a tool.
    q<HTMLButtonElement>('.qb-pick')?.addEventListener('click', (e) => {
      const btn = e.currentTarget as HTMLButtonElement
      btn.classList.add('armed')
      btn.textContent = 'click the map…'
      this.#opts.onPickPoint((lat, lon) => {
        this.#state.lat = Number(lat.toFixed(4))
        this.#state.lon = Number(lon.toFixed(4))
        const latEl = q<HTMLInputElement>('.qb-lat')
        const lonEl = q<HTMLInputElement>('.qb-lon')
        if (latEl) latEl.value = String(this.#state.lat)
        if (lonEl) lonEl.value = String(this.#state.lon)
        btn.classList.remove('armed')
        btn.textContent = 'pick on map'
        this.#syncOutput()
      })
    })

    q<HTMLSelectElement>('.qb-order')?.addEventListener('change', (e) => {
      this.#state.orderField = (e.target as HTMLSelectElement).value || null
      const dir = q<HTMLButtonElement>('.qb-dir')
      if (dir) dir.disabled = !this.#state.orderField
      this.#syncOutput()
    })
    q<HTMLButtonElement>('.qb-dir')?.addEventListener('click', (e) => {
      this.#state.orderDesc = !this.#state.orderDesc
      ;(e.currentTarget as HTMLButtonElement).textContent = this.#state.orderDesc
        ? 'desc'
        : 'asc'
      this.#syncOutput()
    })
    q<HTMLInputElement>('.qb-limit')?.addEventListener('input', (e) => {
      const v = (e.target as HTMLInputElement).value
      this.#state.limit = v === '' ? null : Number(v)
      this.#syncOutput()
    })

    q<HTMLButtonElement>('.qb-run')?.addEventListener('click', () => this.#opts.onRun(this.sql))
    q<HTMLButtonElement>('.qb-edit')?.addEventListener('click', () => this.#opts.onEdit(this.sql))
  }

  #bindFilters(): void {
    const r = this.#root
    const at = (el: Element): FilterClause | undefined =>
      this.#state.filters[Number((el as HTMLElement).dataset.i)]

    r.querySelectorAll<HTMLSelectElement>('.qb-field').forEach((sel) => {
      sel.addEventListener('change', () => {
        const c = at(sel)
        const field = fieldsFor(this.#state.layer).find((f) => f.attr === sel.value)
        if (!c || !field) return
        c.field = field
        c.op = (field.ops ?? NUMERIC_OPS)[0]!
        c.value = field.kind === 'number' ? String(field.min ?? 0) : (field.options?.[0]?.value ?? '')
        this.#renderFilters()
        this.#syncOutput()
      })
    })

    r.querySelectorAll<HTMLSelectElement>('.qb-op').forEach((sel) => {
      sel.addEventListener('change', () => {
        const c = at(sel)
        if (c) c.op = sel.value as CmpOp
        this.#syncOutput()
      })
    })

    const onValue = (el: HTMLInputElement | HTMLSelectElement): void => {
      const c = at(el)
      if (!c) return
      c.value = el.value
      const out = r.querySelector(`[data-out="${(el as HTMLElement).dataset.i}"]`)
      if (out) out.textContent = `${c.value}${c.field.unit ? ` ${c.field.unit}` : ''}`
      this.#syncOutput()
    }

    r.querySelectorAll<HTMLInputElement>('.qb-val-range, .qb-val-text').forEach((el) =>
      el.addEventListener('input', () => onValue(el)),
    )
    r.querySelectorAll<HTMLSelectElement>('.qb-val-enum').forEach((el) =>
      el.addEventListener('change', () => onValue(el)),
    )

    r.querySelectorAll<HTMLButtonElement>('.qb-del').forEach((b) => {
      b.addEventListener('click', () => {
        this.#state.filters.splice(Number(b.dataset.i), 1)
        this.#renderFilters()
        this.#syncOutput()
      })
    })
  }

  #syncOutput(): void {
    const code = this.#root.querySelector('.qb-code')
    if (!code) return
    const { tokens } = compile(this.#spec())
    code.innerHTML = tokens
      .map((t) => `<span class="tk-${t.role}">${escapeHtml(t.text)}</span>`)
      .join(' ')
  }
}
