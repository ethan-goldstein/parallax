// ── web/src/ui/scrubber.ts ──────────────────────────────────────────────────
// The dual-axis bitemporal scrubber. The one control that makes the whole
// concept legible.
//
//   X axis = VALID time   (teal)   — when something was true
//   Y axis = SYSTEM time  (violet) — when we came to believe it
//
// The diagonal marks valid == system: "recorded as it happened". Everything
// ABOVE the diagonal is knowledge about the future — forecasts, predicted
// orbits. Everything BELOW is backfill and correction: we learned it after the
// fact. Labelling those two regions is the single highest-leverage annotation
// in the interface, because it teaches the entire bitemporal model without a
// paragraph of explanation.
//
// The system axis is discrete. It indexes transactions, not seconds — see the
// note in px/store.hpp on why system time is a transaction id. The puck snaps
// to real transactions, which is better than sliding through instants at which
// nothing happened.
// ────────────────────────────────────────────────────────────────────────────
import { fromTimestamp } from '../engine/abi'
import type { Transaction } from '../engine/engine'

export interface ScrubberState {
  /** px::Timestamp — seconds since the 2000-01-01 store epoch. */
  validAt: number
  /** Transaction index on the system axis. */
  sysAt: number
}

export interface ScrubberOptions {
  container: HTMLElement
  validMin: number
  validMax: number
  transactions: Transaction[]
  onChange: (state: ScrubberState) => void
}

const PAD_L = 52
const PAD_R = 16
const PAD_T = 14
const PAD_B = 30

export class Scrubber {
  #canvas: HTMLCanvasElement
  #ctx: CanvasRenderingContext2D
  #opts: ScrubberOptions
  #state: ScrubberState
  #dragging = false
  #lockAxis: 'x' | 'y' | null = null

  constructor(opts: ScrubberOptions) {
    this.#opts = opts

    this.#canvas = document.createElement('canvas')
    this.#canvas.className = 'scrubber'
    this.#canvas.tabIndex = 0
    this.#canvas.setAttribute('role', 'application')
    this.#canvas.setAttribute(
      'aria-label',
      'Bitemporal scrubber. Left and right change valid time. Up and down change system time.',
    )
    opts.container.appendChild(this.#canvas)

    const ctx = this.#canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas context unavailable')
    this.#ctx = ctx

    this.#state = { validAt: opts.validMax, sysAt: Math.max(0, opts.transactions.length - 1) }

    this.#canvas.addEventListener('pointerdown', this.#onDown)
    this.#canvas.addEventListener('pointermove', this.#onMove)
    this.#canvas.addEventListener('pointerup', this.#onUp)
    this.#canvas.addEventListener('pointercancel', this.#onUp)
    this.#canvas.addEventListener('keydown', this.#onKey)
    window.addEventListener('resize', this.resize)

    this.resize()
  }

  get state(): ScrubberState {
    return { ...this.#state }
  }

  setTransactions(txns: Transaction[], validMin: number, validMax: number): void {
    this.#opts.transactions = txns
    this.#opts.validMin = validMin
    this.#opts.validMax = validMax
    this.#state.sysAt = Math.max(0, txns.length - 1)
    this.#state.validAt = validMax
    this.draw()
  }

  // ── geometry ─────────────────────────────────────────────────────────────

  #plot() {
    const w = this.#canvas.clientWidth
    const h = this.#canvas.clientHeight
    return { x0: PAD_L, y0: PAD_T, x1: w - PAD_R, y1: h - PAD_B, w, h }
  }

  #validToX(t: number): number {
    const p = this.#plot()
    const { validMin, validMax } = this.#opts
    const span = Math.max(1, validMax - validMin)
    return p.x0 + ((t - validMin) / span) * (p.x1 - p.x0)
  }

  #xToValid(x: number): number {
    const p = this.#plot()
    const { validMin, validMax } = this.#opts
    const f = Math.max(0, Math.min(1, (x - p.x0) / Math.max(1, p.x1 - p.x0)))
    return Math.round(validMin + f * (validMax - validMin))
  }

  #sysToY(i: number): number {
    const p = this.#plot()
    const n = Math.max(1, this.#opts.transactions.length - 1)
    // Inverted: later transactions at the top, matching the intuition that
    // time accumulates upward and that "most recent" is where you start.
    return p.y1 - (i / n) * (p.y1 - p.y0)
  }

  #yToSys(y: number): number {
    const p = this.#plot()
    const n = Math.max(1, this.#opts.transactions.length - 1)
    const f = Math.max(0, Math.min(1, (p.y1 - y) / Math.max(1, p.y1 - p.y0)))
    return Math.round(f * n)
  }

  // ── input ────────────────────────────────────────────────────────────────

  #onDown = (e: PointerEvent): void => {
    this.#dragging = true
    this.#lockAxis = e.shiftKey ? null : null
    this.#canvas.setPointerCapture(e.pointerId)
    this.#canvas.focus()
    this.#apply(e)
  }

  #onMove = (e: PointerEvent): void => {
    if (!this.#dragging) return
    // Shift locks an axis, so you can isolate "what changed in our knowledge"
    // from "what changed in the world" — which is the comparison the whole
    // control exists to make.
    this.#lockAxis = e.shiftKey ? (this.#lockAxis ?? this.#dominantAxis(e)) : null
    this.#apply(e)
  }

  #onUp = (e: PointerEvent): void => {
    this.#dragging = false
    this.#lockAxis = null
    if (this.#canvas.hasPointerCapture(e.pointerId)) {
      this.#canvas.releasePointerCapture(e.pointerId)
    }
  }

  #dominantAxis(e: PointerEvent): 'x' | 'y' {
    const rect = this.#canvas.getBoundingClientRect()
    const dx = Math.abs(e.clientX - rect.left - this.#validToX(this.#state.validAt))
    const dy = Math.abs(e.clientY - rect.top - this.#sysToY(this.#state.sysAt))
    return dx >= dy ? 'x' : 'y'
  }

  #apply(e: PointerEvent): void {
    const rect = this.#canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    if (this.#lockAxis !== 'y') this.#state.validAt = this.#xToValid(x)
    if (this.#lockAxis !== 'x') this.#state.sysAt = this.#yToSys(y)

    this.draw()
    this.#opts.onChange(this.state)
  }

  #onKey = (e: KeyboardEvent): void => {
    const span = this.#opts.validMax - this.#opts.validMin
    const step = e.shiftKey ? Math.max(1, Math.round(span / 20)) : Math.max(1, Math.round(span / 100))
    let handled = true

    switch (e.key) {
      case 'ArrowLeft':
        this.#state.validAt = Math.max(this.#opts.validMin, this.#state.validAt - step)
        break
      case 'ArrowRight':
        this.#state.validAt = Math.min(this.#opts.validMax, this.#state.validAt + step)
        break
      case 'ArrowUp':
        this.#state.sysAt = Math.min(this.#opts.transactions.length - 1, this.#state.sysAt + 1)
        break
      case 'ArrowDown':
        this.#state.sysAt = Math.max(0, this.#state.sysAt - 1)
        break
      case 'Home':
        this.#state.validAt = this.#opts.validMin
        break
      case 'End':
        this.#state.validAt = this.#opts.validMax
        break
      default:
        handled = false
    }

    if (handled) {
      e.preventDefault()
      this.draw()
      this.#opts.onChange(this.state)
    }
  }

  // ── paint ────────────────────────────────────────────────────────────────

  resize = (): void => {
    const dpr = Math.min(window.devicePixelRatio, 2)
    const w = this.#canvas.clientWidth || 600
    const h = this.#canvas.clientHeight || 150
    this.#canvas.width = Math.round(w * dpr)
    this.#canvas.height = Math.round(h * dpr)
    this.#ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.draw()
  }

  draw(): void {
    const ctx = this.#ctx
    const p = this.#plot()
    const txns = this.#opts.transactions

    ctx.clearRect(0, 0, p.w, p.h)

    const VALID = '#3fd0c9'
    const SYSTEM = '#a78bfa'
    const RULE = '#2a2a30'
    const DIM = '#8a8a93'

    // Plot frame — hairlines only.
    ctx.strokeStyle = RULE
    ctx.lineWidth = 1
    ctx.strokeRect(p.x0 + 0.5, p.y0 + 0.5, p.x1 - p.x0, p.y1 - p.y0)

    // The diagonal, and the two regions it separates. This is the annotation
    // that teaches the model.
    ctx.save()
    ctx.beginPath()
    ctx.rect(p.x0, p.y0, p.x1 - p.x0, p.y1 - p.y0)
    ctx.clip()

    ctx.strokeStyle = 'rgba(232,230,225,0.16)'
    ctx.setLineDash([3, 4])
    ctx.beginPath()
    ctx.moveTo(p.x0, p.y1)
    ctx.lineTo(p.x1, p.y0)
    ctx.stroke()
    ctx.setLineDash([])

    ctx.font = '10px ui-monospace, monospace'
    ctx.fillStyle = 'rgba(138,138,147,0.7)'
    ctx.textAlign = 'left'
    ctx.fillText('KNOWN BEFORE IT HAPPENED', p.x0 + 8, p.y0 + 16)
    ctx.textAlign = 'right'
    ctx.fillText('LEARNED AFTER THE FACT', p.x1 - 8, p.y1 - 8)
    ctx.restore()

    // Transaction ticks on the system axis. Real events, not a continuous
    // gradient — the axis is discrete and should look it.
    ctx.strokeStyle = 'rgba(167,139,250,0.35)'
    for (let i = 0; i < txns.length; i++) {
      const y = this.#sysToY(i)
      ctx.beginPath()
      ctx.moveTo(p.x0, y)
      ctx.lineTo(p.x0 + 5, y)
      ctx.stroke()
    }

    // Crosshair at the current position.
    const cx = this.#validToX(this.#state.validAt)
    const cy = this.#sysToY(this.#state.sysAt)

    ctx.strokeStyle = VALID
    ctx.globalAlpha = 0.55
    ctx.beginPath()
    ctx.moveTo(cx, p.y0)
    ctx.lineTo(cx, p.y1)
    ctx.stroke()

    ctx.strokeStyle = SYSTEM
    ctx.beginPath()
    ctx.moveTo(p.x0, cy)
    ctx.lineTo(p.x1, cy)
    ctx.stroke()
    ctx.globalAlpha = 1

    // Puck.
    ctx.fillStyle = '#ffb000'
    ctx.beginPath()
    ctx.arc(cx, cy, 4.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#0b0b0d'
    ctx.lineWidth = 1.5
    ctx.stroke()

    // Axis labels, in their axis colour. The colour mapping is absolute across
    // the whole application; these are where a user first learns it.
    ctx.font = '10px ui-monospace, monospace'
    ctx.textAlign = 'left'

    ctx.fillStyle = VALID
    ctx.fillText('VALID →', p.x0, p.h - 8)

    ctx.save()
    ctx.translate(12, p.y1)
    ctx.rotate(-Math.PI / 2)
    ctx.fillStyle = SYSTEM
    ctx.fillText('SYSTEM →', 0, 0)
    ctx.restore()

    // Readouts.
    ctx.textAlign = 'right'
    ctx.fillStyle = DIM
    const validLabel = new Date(fromTimestamp(this.#state.validAt) * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 16)
    ctx.fillText(`${validLabel}Z`, p.x1, p.h - 8)

    const txn = txns[this.#state.sysAt]
    if (txn) {
      const sysLabel =
        txn.wallClockUnix > 0
          ? new Date(txn.wallClockUnix * 1000).toISOString().replace('T', ' ').slice(0, 16)
          : 'genesis'
      ctx.fillStyle = SYSTEM
      ctx.textAlign = 'left'
      ctx.fillText(`txn ${this.#state.sysAt}/${txns.length - 1}  ${sysLabel}`, p.x0 + 60, p.y0 - 3)
    }
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize)
    this.#canvas.remove()
  }
}
