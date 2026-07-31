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
// ────────────────────────────────────────────────────────────────────────────
import type { LayerDef } from '../sources/spec'
import { CATEGORIES, type Category, type FeedStatus } from '../sources/spec'

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
  const { host, layers, feeds, visible, counts, onToggle } = opts

  const byLayer = new Map<string, FeedStatus[]>()
  for (const f of feeds) {
    const list = byLayer.get(f.layer)
    if (list) list.push(f)
    else byLayer.set(f.layer, [f])
  }

  const sections: string[] = []

  for (const category of CATEGORIES as readonly Category[]) {
    const inCategory = layers.filter((l) => l.category === category)
    if (inCategory.length === 0) continue

    const blocks = inCategory
      .map((layer) => {
        const sources = byLayer.get(layer.name) ?? []
        // A layer whose every source failed is shown, disabled, with the reason.
        // Hiding it would make a partial picture look complete.
        const live = sources.filter((s) => !s.error)
        const total = counts[layer.name] ?? 0

        const head = `<label class="layer-head">
            <input type="checkbox" data-layer="${escapeHtml(layer.name)}"
                   ${live.length === 0 ? 'disabled' : ''}
                   ${visible[layer.name] === false ? '' : 'checked'} />
            <span class="hud-label">${escapeHtml(layer.label)}</span>
            <span class="v" data-layer-count="${escapeHtml(layer.name)}">${
              live.length === 0 ? '—' : compact(total)
            }</span>
          </label>`

        // Only worth listing sources when there is more than one, or when the
        // single one has something to report.
        const srcRows =
          sources.length > 1 || sources.some((s) => s.error)
            ? sources
                .map(
                  (s) => `<div class="layer-src ${s.error ? 'dead' : ''}">
                      <span>${escapeHtml(s.label.split('·').pop()?.trim() ?? s.label)}</span>
                      <span class="${s.error ? 'bad' : ''}">${
                        s.error ? escapeHtml(s.error.slice(0, 24)) : s.count.toLocaleString()
                      }</span>
                    </div>`,
                )
                .join('')
            : ''

        const note = sources.find((s) => s.coverageNote)?.coverageNote
        const noteRow = note ? `<div class="layer-note">${escapeHtml(note)}</div>` : ''

        return `<div class="layer-block">${head}${legend(layer)}${srcRows}${noteRow}</div>`
      })
      .join('')

    sections.push(
      `<div class="layer-group">
         <div class="layer-group-title hud-label">${category}</div>
         ${blocks}
       </div>`,
    )
  }

  host.innerHTML = sections.join('')

  host.querySelectorAll<HTMLInputElement>('input[data-layer]').forEach((cb) => {
    cb.addEventListener('change', () => onToggle(cb.dataset.layer!, cb.checked))
  })
}
