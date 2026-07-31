// ── web/src/ui/tabs.ts ──────────────────────────────────────────────────────
// The left icon rail and the panel dock it drives.
//
// Before this, every panel was stacked into one of two scrolling columns. Six
// layers and six analysis panels is more than a column can hold, so the layer
// list — the thing a first-time viewer needs first — was a scroll marathon that
// ended below the fold, and four of the analysis panels were simply hidden by a
// media query on any screen under 1180px rather than being given somewhere to go.
//
// One tab is open at a time. That is the whole idea: the map is the document,
// and a panel is a thing you deliberately opened, not permanent furniture
// competing with it for the screen.
//
// Icons are hand-written SVG rather than a library. Six glyphs do not justify a
// dependency, and a stroked 16px path matches the hairline vocabulary the rest
// of the interface is drawn in — an icon font would arrive with its own weight
// and its own idea of what a line looks like.
// ────────────────────────────────────────────────────────────────────────────

export interface TabDef {
  id: string
  /** Shown in the dock header and as the button's accessible name. */
  label: string
  /** 16×16 stroked path data, drawn in currentColor. */
  icon: string
  /** Rail section. A hairline separates data from tools. */
  group: 'data' | 'tools'
  /**
   * Accent for this tab, as CSS. Category tabs derive theirs from the layer
   * they contain, so the rail and the shader cannot disagree about what colour
   * a domain is; tool tabs use the interaction accent.
   */
  accent?: string
}

/** Stroked 16×16 paths. `fill: none; stroke: currentColor` is applied in CSS. */
export const ICONS: Record<string, string> = {
  // A seismogram trace — the domain's own instrument.
  hazards: '<path d="M1 8h3l2-5 2.5 10L11 8h4"/>',
  // A hull on water.
  maritime: '<path d="M2 10.5h12l-1.5 3.5h-9zM8 10.5V3M8 3l4 2.5-4 1.5"/>',
  // A planform aircraft.
  aviation: '<path d="M8 1.5 9 6l5.5 3v1.5L9 9.5v3l2 1.5v1l-3-1-3 1v-1l2-1.5v-3L1.5 10.5V9L7 6z"/>',
  // An orbit crossing a body.
  space:
    '<circle cx="8" cy="8" r="3"/><ellipse cx="8" cy="8" rx="7" ry="3" transform="rotate(-28 8 8)"/>',
  // A node graph — the shape of a lookup.
  network:
    '<circle cx="3" cy="4" r="1.6"/><circle cx="13" cy="4" r="1.6"/><circle cx="8" cy="12.5" r="1.6"/><path d="M4.4 5.1 6.9 11M11.6 5.1 9.1 11M4.6 4h6.8"/>',
  // A prompt caret.
  query: '<path d="M2.5 3.5 6.5 8l-4 4.5M8.5 12.5h5"/>',
  // A die with its pins — the engine itself.
  engine:
    '<rect x="4.5" y="4.5" width="7" height="7" rx="0.5"/><path d="M6.5 1.5v3M9.5 1.5v3M6.5 11.5v3M9.5 11.5v3M1.5 6.5h3M1.5 9.5h3M11.5 6.5h3M11.5 9.5h3"/>',
}

export interface TabRailOptions {
  rail: HTMLElement
  dock: HTMLElement
  tabs: readonly TabDef[]
  /** Which tab opens on load. Null leaves the dock closed. */
  initial: string | null
  onChange?: (id: string | null) => void
}

/**
 * Owns which tab is open, and nothing else.
 *
 * Pane contents are rendered into `paneFor(id)` by their existing render
 * functions — every one of them already takes a host element and owns its
 * innerHTML, so re-homing them into a dock is a change of address, not a
 * rewrite.
 */
export class TabRail {
  #opts: TabRailOptions
  #active: string | null = null
  #panes = new Map<string, HTMLElement>()

  constructor(opts: TabRailOptions) {
    this.#opts = opts
    this.#build()
    this.open(opts.initial)
  }

  get active(): string | null {
    return this.#active
  }

  /** The element a tab's content is rendered into. Stable for the session. */
  paneFor(id: string): HTMLElement {
    const pane = this.#panes.get(id)
    if (!pane) throw new Error(`unknown tab ${id}`)
    return pane
  }

  open(id: string | null): void {
    // Clicking the open tab closes it. On a narrow screen the dock covers the
    // map, so getting back to the map has to be one click on the thing you just
    // pressed — not a hunt for a close control.
    const next = id === this.#active ? null : id
    this.#active = next

    for (const [paneId, pane] of this.#panes) {
      pane.hidden = paneId !== next
    }
    this.#opts.rail.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => {
      const on = b.dataset.tab === next
      b.classList.toggle('on', on)
      b.setAttribute('aria-selected', String(on))
    })

    const def = this.#opts.tabs.find((t) => t.id === next)
    this.#opts.dock.hidden = next === null
    this.#opts.dock.style.setProperty('--tab-accent', def?.accent ?? 'var(--accent)')
    const title = this.#opts.dock.querySelector('.dock-title')
    if (title) title.textContent = def?.label ?? ''

    this.#opts.onChange?.(next)
  }

  #build(): void {
    const { rail, dock, tabs } = this.#opts

    const button = (t: TabDef): string =>
      `<button type="button" role="tab" data-tab="${t.id}" aria-selected="false"
               aria-controls="pane-${t.id}" title="${t.label}" aria-label="${t.label}"
               style="--tab-accent:${t.accent ?? 'var(--accent)'}">
         <svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[t.id] ?? ''}</svg>
         <span class="tab-name hud-label">${t.label}</span>
       </button>`

    const section = (group: TabDef['group']): string =>
      `<div class="tabrail-group">${tabs
        .filter((t) => t.group === group)
        .map(button)
        .join('')}</div>`

    rail.innerHTML = `${section('data')}<div class="tabrail-rule"></div>${section('tools')}`

    dock.innerHTML =
      `<div class="dock-head">
         <span class="dock-title hud-label"></span>
         <button type="button" class="dock-close" aria-label="close panel">
           <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>
         </button>
       </div>
       <div class="dock-body">${tabs
         .map(
           (t) =>
             `<section class="pane" id="pane-${t.id}" role="tabpanel"
                       aria-labelledby="tab-${t.id}" hidden></section>`,
         )
         .join('')}</div>`

    for (const t of tabs) {
      this.#panes.set(t.id, dock.querySelector<HTMLElement>(`#pane-${t.id}`)!)
    }

    rail.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => {
      b.addEventListener('click', () => this.open(b.dataset.tab!))
    })
    dock.querySelector('.dock-close')?.addEventListener('click', () => this.open(null))
  }
}
