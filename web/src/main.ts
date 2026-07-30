// ── web/src/main.ts ─────────────────────────────────────────────────────────
// Phase 1: boot the engine, prove the whole pipeline works, and say so on
// screen in the project's own visual language.
//
// This page is temporary as a UI, but it is not throwaway as a diagnostic. It
// answers, at a glance, the questions that are otherwise expensive to ask:
// did the WASM module load, is it the SIMD build, is this a stale cached
// bundle, and how long did instantiation actually take.
// ────────────────────────────────────────────────────────────────────────────
import './ui/tokens.css'
import './ui/boot-readout.css'

import { bootEngine, EngineBootError } from './engine/boot'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('#app is missing from index.html')

function row(label: string, value: string, tone?: 'ok' | 'warn'): string {
  const cls = tone ? ` class="v ${tone}"` : ' class="v"'
  return `<div class="row"><span class="hud-label">${label}</span><span${cls}>${value}</span></div>`
}

async function main(): Promise<void> {
  app!.innerHTML = `
    <main class="plate">
      <header class="plate-head">
        <h1>PARALLAX</h1>
        <p class="sub">Bitemporal analytical engine &middot; C++20 &rarr; WebAssembly</p>
      </header>
      <section id="readout" class="readout">
        ${row('engine', 'instantiating…')}
      </section>
      <footer class="plate-foot">
        <span class="hud-label">Phase 1 &middot; walking skeleton</span>
      </footer>
    </main>`

  const readout = document.querySelector<HTMLElement>('#readout')!

  // performance.now() around instantiation: streaming compilation of a module
  // this small is dominated by fetch latency, but the number becomes meaningful
  // as the engine grows and it costs one line to start tracking now.
  const t0 = performance.now()

  try {
    const engine = await bootEngine()
    const bootMs = performance.now() - t0

    readout.innerHTML = [
      row('status', 'READY', 'ok'),
      row('version', engine.version()),
      row('target', engine.buildTarget()),
      row('simd', engine.hasSimd() ? 'v128 enabled' : 'scalar', engine.hasSimd() ? 'ok' : 'warn'),
      row('boot', `${bootMs.toFixed(1)} ms`),
      row('heap', `${(engine.HEAPU8.byteLength / (1024 * 1024)).toFixed(0)} MB reserved`),
    ].join('')
  } catch (err) {
    const detail =
      err instanceof EngineBootError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err)

    readout.innerHTML = row('status', 'FAILED', 'warn') + row('detail', detail)

    // Keep the underlying cause in the console rather than on screen — the
    // page states what happened, the console states why.
    console.error('[parallax] engine boot failed', err)
  }
}

void main()
