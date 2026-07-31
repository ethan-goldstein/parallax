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
  /**
   * Where the valid axis starts, defaulting to its maximum.
   *
   * That default stopped being right once a source with a BOUNDED validity
   * window arrived. `validMax` is the furthest-future instant any fact claims,
   * and the aurora forecast claims about eighty minutes ahead — so the axis
   * opened in the future, where a satellite valid for ±150 seconds around now
   * does not exist, and both layers rendered zero points on a working feed.
   *
   * "Now" is also just the better answer to what a viewer wants first.
   */
  validAt?: number
  transactions: Transaction[]
  onChange: (state: ScrubberState) => void
}

const PAD_L = 52
const PAD_R = 16
const PAD_T = 14
const PAD_B = 30

/**
 * The palette, read from the stylesheet rather than repeated here.
 *
 * A canvas cannot use a CSS custom property, so these used to be six hex
 * literals in the draw call — a second copy of the two colours that carry the
 * most meaning in the entire interface. `--valid-time` and `--system-time` are
 * load-bearing: teal means "when it was true" and violet means "when we believed
 * it" everywhere, and a scrubber drawing its own slightly different teal would
 * break the one association the whole design depends on.
 *
 * Read once at construction. These are design tokens, not a live theme.
 */
interface Palette {
  valid: string
  system: string
  rule: string
  dim: string
  accent: string
  bg: string
}

function readPalette(): Palette {
  const s = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string): string =>
    s.getPropertyValue(name).trim() || fallback
  return {
    valid: token('--valid-time', '#3fd0c9'),
    system: token('--system-time', '#a78bfa'),
    rule: token('--rule', '#2a2a30'),
    dim: token('--ink-dim', '#8a8a93'),
    accent: token('--accent', '#ffb000'),
    bg: token('--bg', '#0b0b0d'),
  }
}

export class Scrubber {
  #canvas: HTMLCanvasElement
  #ctx: CanvasRenderingContext2D
  #opts: ScrubberOptions
  #state: ScrubberState
  #dragging = false
  #lockAxis: 'x' | 'y' | null = null
  #palette = readPalette()

  /**
   * Whether the valid axis is still following the present.
   *
   * Set false the first time a human moves it, and never set back — the same
   * `tail -f` question as the system axis, against a different clock.
   *
   * Without this the axis froze at the instant of page load while "now" kept
   * moving, so every layer whose facts are only valid around the present drained
   * away: aircraft positions arriving from a poll fifty seconds later were, from
   * the axis's point of view, in the future. Military traffic rendered 198
   * points at boot and 0 a minute afterwards, on a feed that was working
   * perfectly the whole time.
   */
  #followNow = true

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

    this.#state = {
      validAt: Math.min(Math.max(opts.validAt ?? opts.validMax, opts.validMin), opts.validMax),
      sysAt: Math.max(0, opts.transactions.length - 1),
    }

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

  /**
   * Extends both axes after new data arrives.
   *
   * `follow` is the `tail -f` question. Someone sitting on the newest
   * transaction is watching the present and wants to keep watching it; someone
   * parked at transaction 400 is examining what was believed then, and jumping
   * them to the newest would destroy exactly the thing they were looking at.
   * So the position is only advanced if it was already at the end.
   */
  setTransactions(
    txns: Transaction[],
    validMin: number,
    validMax: number,
    follow = false,
    /** Present instant, as a px::Timestamp. */
    nowValid?: number,
  ): void {
    const wasAtEnd = this.#state.sysAt >= this.#opts.transactions.length - 1

    this.#opts.transactions = txns
    this.#opts.validMin = validMin
    this.#opts.validMax = validMax

    if (!follow || wasAtEnd) this.#state.sysAt = Math.max(0, txns.length - 1)
    else this.#state.sysAt = Math.min(this.#state.sysAt, Math.max(0, txns.length - 1))

    if (!follow) {
      this.#state.validAt = nowValid ?? validMax
      this.#followNow = true
    } else if (this.#followNow && nowValid !== undefined) {
      // Still watching the present, so the present is where it stays.
      this.#state.validAt = nowValid
    }
    this.#state.validAt = Math.min(Math.max(this.#state.validAt, validMin), validMax)

    this.draw()
  }

  /** True while the valid axis is still tracking the present. */
  get followingNow(): boolean {
    return this.#followNow
  }

  get validMin(): number {
    return this.#opts.validMin
  }

  get validMax(): number {
    return this.#opts.validMax
  }

  /**
   * Parks both axes and stops them tracking the present, exactly as a drag does.
   *
   * Distinct from `setValidAt`, which is the clock advancing. Anything moving
   * the axes on a viewer's BEHALF has to pin them, or the follow tick in main.ts
   * snaps straight back to now — which is what silently undid every axis move the
   * guided tour made, leaving it narrating a rewind that never happened.
   */
  pin(next: Partial<ScrubberState>): void {
    if (next.validAt !== undefined) {
      this.#state.validAt = Math.min(
        Math.max(next.validAt, this.#opts.validMin),
        this.#opts.validMax,
      )
    }
    if (next.sysAt !== undefined) {
      this.#state.sysAt = Math.min(
        Math.max(next.sysAt, 0),
        Math.max(0, this.#opts.transactions.length - 1),
      )
    }
    this.#followNow = false
    this.draw()
  }

  /** Resumes tracking the present. */
  release(): void {
    this.#followNow = true
  }

  /**
   * Moves the valid axis without ending follow mode.
   *
   * Distinct from a drag on purpose: this is the clock advancing, not a person
   * choosing an instant, and only the latter should stop the axis tracking now.
   */
  setValidAt(t: number): void {
    const next = Math.min(Math.max(t, this.#opts.validMin), this.#opts.validMax)
    if (next === this.#state.validAt) return
    this.#state.validAt = next
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

    if (this.#lockAxis !== 'y') {
      this.#state.validAt = this.#xToValid(x)
      this.#followNow = false
    }
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
        this.#followNow = false
        break
      case 'ArrowRight':
        this.#state.validAt = Math.min(this.#opts.validMax, this.#state.validAt + step)
        this.#followNow = false
        break
      case 'ArrowUp':
        this.#state.sysAt = Math.min(this.#opts.transactions.length - 1, this.#state.sysAt + 1)
        break
      case 'ArrowDown':
        this.#state.sysAt = Math.max(0, this.#state.sysAt - 1)
        break
      case 'Home':
        this.#state.validAt = this.#opts.validMin
        this.#followNow = false
        break
      case 'End':
        this.#state.validAt = this.#opts.validMax
        this.#followNow = false
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

    const { valid: VALID, system: SYSTEM, rule: RULE, dim: DIM } = this.#palette

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
    ctx.fillStyle = this.#palette.accent
    ctx.beginPath()
    ctx.arc(cx, cy, 4.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = this.#palette.bg
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
