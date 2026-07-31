// ── web/src/ui/shell.ts ─────────────────────────────────────────────────────
// The static chrome: everything that exists before any data does.
//
// Lifted out of main.ts, where it was a ninety-line template literal wedged
// between the imports and the boot sequence. main.ts is about wiring an engine
// to a view; the shape of the view is a separate concern and reads better as one.
//
// What is NOT here: the panels. Every analysis panel is rendered into a host by
// its own module, and the tab dock creates those hosts at runtime — so this file
// describes the frame and nothing that hangs in it.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The parts of the shell the rest of the app addresses by name.
 *
 * Returned as a resolved object rather than left to `querySelector` calls
 * scattered through main.ts: a typo in a selector string is a runtime null at
 * some later moment, and this way it is one failure at startup.
 */
export interface Shell {
  stage: HTMLElement
  status: HTMLElement
  tabrail: HTMLElement
  dock: HTMLElement
  readout: HTMLElement
  inspector: HTMLElement
  tooltip: HTMLElement
  scrubberHost: HTMLElement
  engineTag: HTMLElement
  purpose: HTMLSelectElement
}

const TEMPLATE = `
  <div id="stage" class="stage"></div>

  <header class="hud hud-top">
    <div class="brand">
      <span class="brand-mark">PARALLAX</span>
      <span class="brand-sub">bitemporal analytical engine</span>
    </div>
    <div class="hud-right">
      <label class="purpose">
        <span class="hud-label">purpose</span>
        <select id="purpose">
          <option value="demonstration">demonstration</option>
          <option value="maritime-safety">maritime safety</option>
          <option value="disaster-response">disaster response</option>
        </select>
      </label>
      <div id="status" class="status hud-label">booting engine…</div>
    </div>
  </header>

  <nav class="tabrail" id="tabrail" role="tablist" aria-label="panels"></nav>
  <aside class="dock" id="dock" hidden></aside>

  <aside class="rail rail-right">
    <section class="panel readout" id="readout" aria-live="polite"></section>
    <section class="panel inspector" id="inspector"></section>
  </aside>

  <div class="tooltip" id="tooltip" hidden></div>

  <div class="map-controls">
    <div class="seg" id="basemap-seg" role="group" aria-label="basemap">
      <button type="button" data-basemap="dark" class="on">dark</button>
      <button type="button" data-basemap="sat">satellite</button>
      <button type="button" data-basemap="live">live</button>
    </div>
    <div class="seg" id="projection-seg" role="group" aria-label="projection">
      <button type="button" data-projection="globe" class="on">3D</button>
      <button type="button" data-projection="mercator">2D</button>
    </div>
  </div>

  <footer class="hud hud-bottom">
    <div id="scrubber-host" class="scrubber-host"></div>
    <div class="attribution hud-label"><span id="engine-tag"></span></div>
  </footer>
`

export function buildShell(app: HTMLElement): Shell {
  app.innerHTML = TEMPLATE

  const pick = <T extends HTMLElement>(sel: string): T => {
    const el = app.querySelector<T>(sel)
    if (!el) throw new Error(`shell is missing ${sel}`)
    return el
  }

  return {
    stage: pick('#stage'),
    status: pick('#status'),
    tabrail: pick('#tabrail'),
    dock: pick('#dock'),
    readout: pick('#readout'),
    inspector: pick('#inspector'),
    tooltip: pick('#tooltip'),
    scrubberHost: pick('#scrubber-host'),
    engineTag: pick('#engine-tag'),
    purpose: pick<HTMLSelectElement>('#purpose'),
  }
}
