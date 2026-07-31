// ── web/src/ui/layerPanel.ts ────────────────────────────────────────────────
// The layer panel, and the map's legend.
//
// The legend is the point. Before it, the globe was coloured dots with no stated
// meaning — amber ones, teal ones, green ones, all different sizes, and nothing
// on screen said what any of it encoded. A map that cannot be read is decoration.
//
// Each layer therefore shows its own colour ramp with the attribute and range
// that ramp is bound to, taken from the LayerDef the renderer is actually using
// rather than written out by hand. A legend that can drift from the shader is
// worse than none.
//
// Structure is layer-first, sources nested under it. That mirrors what a viewer
// sees: one visual thing on the map, fed by one or more agencies. USGS and EMSC
// are two rows under one checkbox because they are two views of one layer.
//
// ── why the detail collapses ────────────────────────────────────────────────
//
// Each layer has four things to say: whether it is on, what its colour encodes,
// which agencies feed it, and where its coverage is not what you would assume.
// Rendered flat that is roughly 150px per layer, so four layers overflowed the
// panel and the fourth was below the fold — which is how a viewer concluded the
// map had no maritime or aviation data at all.
//
// The head row alone answers "what is on the map"; everything else is a follow-up
// question and lives behind a disclosure. Native <details> rather than a class
// toggle, because it gets keyboard operation and the open/closed state for free,
// and because find-in-page can reach into a closed one.
// ────────────────────────────────────────────────────────────────────────────
import type { LayerDef } from '../sources/spec'
import { type Category, type FeedStatus } from '../sources/spec'

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

/** Attribute names are engine identifiers; this is what a person calls them. */
function readable(attr: string): string {
  return attr.replace(/_/g, ' ').replace(/^(aurora|alert|event|aircraft|vessel) /, '')
}

function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
}

/**
 * The legend row: the exact gradient the shader interpolates, and the range it
 * is stretched across.
 *
 * A flat ramp (colorLow === colorHigh) means the scalar carries no information —
 * EONET's magnitudes are in incomparable units, so its layer is deliberately
 * uniform. Saying "uniform" is more honest than drawing a gradient that implies
 * an ordering the data does not have.
 */
function legend(layer: LayerDef): string {
  const { colorLow, colorHigh, rampLow, rampHigh } = layer.visual
  const flat = colorLow === colorHigh
  const swatch = flat
    ? `background:${hex(colorLow)}`
    : `background:linear-gradient(90deg, ${hex(colorLow)}, ${hex(colorHigh)})`

  const caption = flat
    ? 'uniform — units not comparable'
    : `${escapeHtml(readable(layer.scalarAttr))} ${rampLow} → ${rampHigh}`

  return `<div class="layer-key">
      <span class="layer-ramp" style="${swatch}"></span>
      <span>${caption}</span>
    </div>`
}

export interface LayerPanelOptions {
  host: HTMLElement
  layers: readonly LayerDef[]
  feeds: readonly FeedStatus[]
  visible: Readonly<Record<string, boolean>>
  counts: Readonly<Record<string, number>>
  onToggle: (layer: string, visible: boolean) => void
  /** Render only this category. Omitted renders every one, in CATEGORIES order. */
  category?: Category
  /**
   * Refresh timings by source key.
   *
   * Shown because invisible polling might as well not be happening: a viewer who
   * cannot tell a live feed from a frozen one has no reason to believe either.
   */
  timings?: ReadonlyMap<string, { lastFetch: number | null; nextDue: number | null }>
}

/** `12s ago · next in 8s`, or null when the source is fetched once at boot. */
function cadence(
  t: { lastFetch: number | null; nextDue: number | null } | undefined,
  now: number,
): string | null {
  if (!t || t.nextDue === null) return null
  const parts: string[] = []
  if (t.lastFetch !== null) parts.push(`${Math.max(0, Math.round(now - t.lastFetch))}s ago`)
  parts.push(`next in ${Math.max(0, Math.round(t.nextDue - now))}s`)
  return parts.join(' · ')
}

/**
 * Refreshes just the counts.
 *
 * Called on every scrub, so it writes text into existing nodes rather than
 * rebuilding the panel — a full re-render would drop the checkbox the user is
 * mid-click on and thrash the layout sixty times a second.
 */
export function updateLayerCounts(
  host: HTMLElement,
  counts: Readonly<Record<string, number>>,
): void {
  host.querySelectorAll<HTMLElement>('[data-layer-count]').forEach((el) => {
    const n = counts[el.dataset.layerCount!]
    if (n !== undefined && el.textContent !== '—') el.textContent = compact(n)
  })
}

export function renderLayerPanel(opts: LayerPanelOptions): void {
  const { host, layers, feeds, visible, counts, onToggle, category, timings } = opts
  const now = Date.now() / 1000

  const byLayer = new Map<string, FeedStatus[]>()
  for (const f of feeds) {
    const list = byLayer.get(f.layer)
    if (list) list.push(f)
    else byLayer.set(f.layer, [f])
  }

  const inScope = category ? layers.filter((l) => l.category === category) : layers

  host.innerHTML = inScope
    .map((layer) => {
      const sources = byLayer.get(layer.name) ?? []
      // A layer whose every source failed is shown, disabled, with the reason.
      // Hiding it would make a partial picture look complete.
      const live = sources.filter((s) => !s.error)
      const dead = live.length === 0
      const total = counts[layer.name] ?? 0

      // The checkbox lives inside the <summary>, so a click on it would also
      // toggle the disclosure. Suppressed below rather than moved out, because
      // "the control and its name are one row" is worth one event listener.
      const head = `<summary class="layer-head">
          <input type="checkbox" data-layer="${escapeHtml(layer.name)}"
                 ${dead ? 'disabled' : ''}
                 ${visible[layer.name] === false ? '' : 'checked'}
                 aria-label="${escapeHtml(layer.label)}" />
          <span class="hud-label">${escapeHtml(layer.label)}</span>
          <span class="v" data-layer-count="${escapeHtml(layer.name)}">${
            dead ? '—' : compact(total)
          }</span>
          <svg class="layer-chev" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6 4l4 4-4 4"/>
          </svg>
        </summary>`

      // Only worth listing sources when there is more than one, or when the
      // single one has something to report.
      const srcRows =
        sources.length > 1 || sources.some((s) => s.error)
          ? sources
              .map((s) => {
                const rate = cadence(timings?.get(s.key), now)
                return `<div class="layer-src ${s.error ? 'dead' : ''}">
                    <span>${escapeHtml(s.label.split('·').pop()?.trim() ?? s.label)}</span>
                    <span class="${s.error ? 'bad' : ''}">${
                      s.error ? escapeHtml(s.error.slice(0, 24)) : s.count.toLocaleString()
                    }</span>
                    ${rate ? `<span class="layer-rate">${escapeHtml(rate)}</span>` : ''}
                  </div>`
              })
              .join('')
          : sources
              .map((s) => {
                const rate = cadence(timings?.get(s.key), now)
                return rate ? `<div class="layer-src"><span class="layer-rate">${escapeHtml(rate)}</span></div>` : ''
              })
              .join('')

      const note = sources.find((s) => s.coverageNote)?.coverageNote
      const noteRow = note ? `<div class="layer-note">${escapeHtml(note)}</div>` : ''

      // A layer holding facts none of which are valid at the instant the
      // scrubber is on renders zero points, and a bare "0" is indistinguishable
      // from a broken feed. The aurora layer is permanently in this state on
      // arrival — it forecasts about eighty minutes ahead, so at the present
      // instant it is correctly empty. Saying so turns a confusing zero into the
      // clearest possible statement of what the valid axis is FOR.
      const ingested = sources.reduce((n, s) => n + s.count, 0)
      const timeNote =
        !dead && total === 0 && ingested > 0
          ? `<div class="layer-note layer-elsewhere">${ingested.toLocaleString()} facts held, none valid at the instant the scrubber is on — drag the valid axis to reach them</div>`
          : ''

      // A dead layer opens by default: the reason it is dead is the only thing
      // worth reading about it, and hiding that behind a disclosure would make a
      // broken feed look like a feed with nothing in it.
      return `<details class="layer-block"${dead ? ' open' : ''}>
          ${head}
          <div class="layer-detail">${legend(layer)}${srcRows}${timeNote}${noteRow}</div>
        </details>`
    })
    .join('')

  host.querySelectorAll<HTMLInputElement>('input[data-layer]').forEach((cb) => {
    cb.addEventListener('click', (e) => e.stopPropagation())
    cb.addEventListener('change', () => onToggle(cb.dataset.layer!, cb.checked))
  })
}
