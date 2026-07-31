// ── web/src/render/icons.ts ─────────────────────────────────────────────────
// The glyph atlas: one texture holding every mark the map can draw.
//
// ── why the dots were not enough ────────────────────────────────────────────
//
// Every layer rendered as a coloured disc, so the map said "something is here"
// and nothing else. Which colour meant aircraft and which meant vessels was a
// fact you had to hold in your head, or go and read off the legend and carry
// back. A plane-shaped mark says it without the round trip.
//
// ── why an atlas and not procedural SDFs ────────────────────────────────────
//
// Signed-distance functions in GLSL are the other way to do this, and they are
// genuinely better for a circle or a rounded rectangle. They are much worse for
// an airliner: a recognisable plane silhouette is a dozen curves, and a dozen
// hand-tuned GLSL curves per glyph across twelve glyphs is a lot of code that
// can only be verified by looking at it. Canvas paths are read by anyone.
//
// The atlas is drawn once at boot into an offscreen canvas and uploaded as a
// single texture. It costs one texture bind per layer per frame and nothing per
// point — the instance path from the wasm heap to `bufferSubData` is untouched.
//
// ── the two channels ────────────────────────────────────────────────────────
//
// RED holds a thick stroke of the outline, GREEN the filled body. The fragment
// shader tints GREEN with the layer's ramp colour and draws RED-minus-GREEN as a
// dark rim, so a mark stays legible against the satellite basemap as well as the
// dark one. Compositing with `lighter` is what keeps the two independent in one
// draw rather than needing two textures.
// ────────────────────────────────────────────────────────────────────────────

/** Cell edge in texels. 64 is enough for a 16px mark on a 2× display. */
export const CELL = 64

/** Cells per row. Twelve glyphs fit in two rows of six. */
export const COLS = 6

/**
 * Glyph names, in atlas order.
 *
 * A layer names one of these in its `LayerSpec`. Adding a mark means a path
 * function below plus a name here; the index is derived, never written down.
 */
export const GLYPH_NAMES = [
  'quake',
  'ship',
  'anchor',
  'strait',
  'warning',
  'flame',
  'storm',
  'jet',
  'airliner',
  'satellite',
  'aurora',
  'node',
] as const

export type GlyphName = (typeof GLYPH_NAMES)[number]

/**
 * How a glyph is drawn.
 *
 * The first pass at this filled every path and also stroked it, which fattened
 * everything until interior detail closed up: the exclamation bar vanished
 * inside the warning triangle, and the satellite's solar panels merged with its
 * body into one bar with a lump on top. Shapes therefore say how they want to be
 * drawn, and one that needs a hole says so explicitly.
 */
interface GlyphDef {
  /** The silhouette. */
  draw: (p: Path2D) => void
  /**
   * `fill` for a solid body, `stroke` for a line drawing.
   *
   * An open path — the aurora bands, the quake arcs — has no interior, so
   * filling it produces nothing.
   */
  mode?: 'fill' | 'stroke'
  /** Line width at the 100-unit scale, for `stroke` mode. */
  weight?: number
  /**
   * Punched out of the body AND the rim after both are drawn.
   *
   * A hole has to come out of both channels or the rim fills it back in.
   */
  knockout?: (p: Path2D) => void
}

/**
 * The marks, drawn on a 100×100 box.
 *
 * Everything is expressed at that scale and transformed into the cell, so a
 * change to CELL does not mean re-tuning twelve sets of coordinates. Vehicles
 * are drawn from above and fixed things from the side, which is the convention
 * a chart uses and the one a viewer already knows.
 */
const GLYPHS: Record<GlyphName, GlyphDef> = {
  // Concentric arcs radiating from a point: the epicentre notation on every
  // seismic map ever printed.
  quake: {
    mode: 'stroke',
    weight: 11,
    draw: (p) => {
      p.moveTo(56, 50)
      p.arc(50, 50, 6, 0, Math.PI * 2)
      for (const r of [21, 36]) {
        p.moveTo(50 + r * Math.cos(-0.85), 50 + r * Math.sin(-0.85))
        p.arc(50, 50, r, -0.85, 0.85)
        p.moveTo(50 + r * Math.cos(Math.PI - 0.85), 50 + r * Math.sin(Math.PI - 0.85))
        p.arc(50, 50, r, Math.PI - 0.85, Math.PI + 0.85)
      }
    },
  },

  // Long low hull with a raked bow and a deckhouse set aft. The first version
  // had a mast, which at fifteen pixels merged with the superstructure and made
  // the whole thing read as a mushroom.
  ship: {
    draw: (p) => {
      p.moveTo(8, 56)
      p.lineTo(92, 56)
      p.lineTo(80, 76)
      p.lineTo(20, 76)
      p.closePath()
      p.moveTo(34, 56)
      p.lineTo(34, 38)
      p.lineTo(62, 38)
      p.lineTo(62, 56)
      p.closePath()
    },
  },

  // Ring, shank, stock and flukes.
  anchor: {
    mode: 'stroke',
    weight: 12,
    draw: (p) => {
      p.moveTo(58, 22)
      p.arc(50, 22, 8, 0, Math.PI * 2)
      p.moveTo(50, 30)
      p.lineTo(50, 80)
      p.moveTo(30, 40)
      p.lineTo(70, 40)
      p.moveTo(22, 56)
      p.quadraticCurveTo(24, 80, 50, 80)
      p.quadraticCurveTo(76, 80, 78, 56)
    },
  },

  // An hourglass: a waist everything has to pass through. Drawn as two facing
  // triangles because the earlier "two headlands and a gap" read as a book.
  strait: {
    draw: (p) => {
      p.moveTo(16, 10)
      p.lineTo(84, 10)
      p.lineTo(56, 50)
      p.lineTo(84, 90)
      p.lineTo(16, 90)
      p.lineTo(44, 50)
      p.closePath()
    },
  },

  // Triangle with the bar and dot knocked out, so they survive the rim stroke.
  warning: {
    draw: (p) => {
      p.moveTo(50, 12)
      p.lineTo(92, 84)
      p.lineTo(8, 84)
      p.closePath()
    },
    knockout: (p) => {
      p.moveTo(44, 38)
      p.lineTo(56, 38)
      p.lineTo(56, 62)
      p.lineTo(44, 62)
      p.closePath()
      p.moveTo(56, 70)
      p.arc(50, 70, 6, 0, Math.PI * 2)
    },
  },

  // A flame with a curled tip and a notched base — the earlier symmetric
  // teardrop read as a leaf.
  flame: {
    draw: (p) => {
      p.moveTo(52, 8)
      p.quadraticCurveTo(58, 30, 72, 44)
      p.quadraticCurveTo(84, 58, 76, 72)
      p.quadraticCurveTo(68, 90, 48, 90)
      p.quadraticCurveTo(24, 90, 22, 68)
      p.quadraticCurveTo(21, 54, 34, 44)
      p.quadraticCurveTo(34, 56, 42, 58)
      p.quadraticCurveTo(50, 46, 44, 32)
      p.quadraticCurveTo(48, 20, 52, 8)
      p.closePath()
    },
  },

  // Cloud with a bolt below it.
  storm: {
    draw: (p) => {
      p.moveTo(26, 52)
      p.quadraticCurveTo(10, 52, 12, 38)
      p.quadraticCurveTo(14, 26, 30, 28)
      p.quadraticCurveTo(34, 10, 52, 12)
      p.quadraticCurveTo(70, 14, 72, 30)
      p.quadraticCurveTo(88, 30, 88, 42)
      p.quadraticCurveTo(88, 52, 74, 52)
      p.closePath()
      p.moveTo(56, 56)
      p.lineTo(38, 76)
      p.lineTo(50, 76)
      p.lineTo(42, 94)
      p.lineTo(64, 70)
      p.lineTo(51, 70)
      p.closePath()
    },
  },

  // Delta planform, sharply swept — a fast jet from above.
  jet: {
    draw: (p) => {
      p.moveTo(50, 8)
      p.lineTo(58, 34)
      p.lineTo(88, 68)
      p.lineTo(88, 76)
      p.lineTo(56, 62)
      p.lineTo(56, 80)
      p.lineTo(66, 90)
      p.lineTo(50, 86)
      p.lineTo(34, 90)
      p.lineTo(44, 80)
      p.lineTo(44, 62)
      p.lineTo(12, 76)
      p.lineTo(12, 68)
      p.lineTo(42, 34)
      p.closePath()
    },
  },

  // Straight high-aspect wings and a wider fuselage — an airliner from above.
  airliner: {
    draw: (p) => {
      p.moveTo(50, 8)
      p.quadraticCurveTo(57, 16, 57, 38)
      p.lineTo(92, 56)
      p.lineTo(92, 64)
      p.lineTo(57, 56)
      p.lineTo(57, 76)
      p.lineTo(68, 86)
      p.lineTo(68, 92)
      p.lineTo(50, 86)
      p.lineTo(32, 92)
      p.lineTo(32, 86)
      p.lineTo(43, 76)
      p.lineTo(43, 56)
      p.lineTo(8, 64)
      p.lineTo(8, 56)
      p.lineTo(43, 38)
      p.quadraticCurveTo(43, 16, 50, 8)
      p.closePath()
    },
  },

  // Bus with two wings, and the gaps between them knocked out so the three parts
  // stay three parts rather than fusing into one bar under the rim stroke.
  satellite: {
    draw: (p) => {
      p.moveTo(41, 34)
      p.lineTo(59, 34)
      p.lineTo(59, 66)
      p.lineTo(41, 66)
      p.closePath()
      p.moveTo(4, 40)
      p.lineTo(35, 40)
      p.lineTo(35, 60)
      p.lineTo(4, 60)
      p.closePath()
      p.moveTo(65, 40)
      p.lineTo(96, 40)
      p.lineTo(96, 60)
      p.lineTo(65, 60)
      p.closePath()
    },
    knockout: (p) => {
      // The booms, and one panel division per wing.
      p.moveTo(35, 46)
      p.lineTo(41, 46)
      p.lineTo(41, 54)
      p.lineTo(35, 54)
      p.closePath()
      p.moveTo(59, 46)
      p.lineTo(65, 46)
      p.lineTo(65, 54)
      p.lineTo(59, 54)
      p.closePath()
      p.moveTo(18, 40)
      p.lineTo(22, 40)
      p.lineTo(22, 60)
      p.lineTo(18, 60)
      p.closePath()
      p.moveTo(78, 40)
      p.lineTo(82, 40)
      p.lineTo(82, 60)
      p.lineTo(78, 60)
      p.closePath()
    },
  },

  // Three drifting bands — the oval as it is drawn on a forecast map.
  aurora: {
    mode: 'stroke',
    weight: 10,
    draw: (p) => {
      for (const y of [32, 50, 68]) {
        p.moveTo(8, y)
        p.bezierCurveTo(28, y - 15, 44, y + 15, 62, y - 3)
        p.bezierCurveTo(76, y - 13, 84, y + 7, 94, y - 5)
      }
    },
  },

  // Three nodes and their edges: a lookup is a thing about a network rather than
  // a thing in a place. Thin edges so the nodes stay distinct circles.
  node: {
    mode: 'stroke',
    weight: 9,
    draw: (p) => {
      const pts: [number, number][] = [
        [24, 26],
        [76, 26],
        [50, 78],
      ]
      p.moveTo(pts[0]![0], pts[0]![1])
      p.lineTo(pts[1]![0], pts[1]![1])
      p.lineTo(pts[2]![0], pts[2]![1])
      p.closePath()
      for (const [x, y] of pts) {
        p.moveTo(x + 12, y)
        p.arc(x, y, 12, 0, Math.PI * 2)
      }
    },
  },
}

export interface Atlas {
  canvas: HTMLCanvasElement
  cols: number
  rows: number
  cell: number
  /** Glyph name → its index in the atlas. */
  index: Readonly<Record<string, number>>
}

let cached: Atlas | null = null

/**
 * Draws every glyph once and returns the sheet.
 *
 * Memoised at module scope: every layer shares one texture, and rebuilding it
 * per layer would be twelve canvases and twelve uploads for identical bytes.
 */
export function buildAtlas(): Atlas {
  if (cached) return cached

  const rows = Math.ceil(GLYPH_NAMES.length / COLS)
  const canvas = document.createElement('canvas')
  canvas.width = COLS * CELL
  canvas.height = rows * CELL

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas context unavailable for the glyph atlas')

  // Red and green accumulate independently, which is what lets one texture carry
  // both the body and its rim.
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  const index: Record<string, number> = {}

  GLYPH_NAMES.forEach((name, i) => {
    const col = i % COLS
    const row = Math.floor(i / COLS)
    index[name] = i

    ctx.save()
    ctx.translate(col * CELL, row * CELL)
    // A margin, so the rim stroke cannot bleed into the neighbouring cell and
    // show up as a stray edge on an unrelated glyph.
    const s = (CELL * 0.86) / 100
    ctx.translate(CELL * 0.07, CELL * 0.07)
    ctx.scale(s, s)

    const def = GLYPHS[name]
    const path = new Path2D()
    def.draw(path)

    // RED: the rim. Stroked wide and first, so the body sits inside it.
    ctx.globalCompositeOperation = 'lighter'
    ctx.strokeStyle = 'rgb(255,0,0)'
    ctx.lineWidth = 22
    ctx.stroke(path)

    // GREEN: the body.
    ctx.fillStyle = 'rgb(0,255,0)'
    ctx.strokeStyle = 'rgb(0,255,0)'
    if ((def.mode ?? 'fill') === 'fill') {
      ctx.fill(path)
      // A hairline stroke only, to close the seam between fill and rim without
      // eating the interior detail.
      ctx.lineWidth = 3
      ctx.stroke(path)
    } else {
      ctx.lineWidth = def.weight ?? 10
      ctx.stroke(path)
    }

    // Holes come out of both channels, or the rim fills them back in.
    if (def.knockout) {
      const hole = new Path2D()
      def.knockout(hole)
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fill(hole)
      ctx.globalCompositeOperation = 'lighter'
    }

    ctx.restore()
  })

  cached = { canvas, cols: COLS, rows, cell: CELL, index }
  return cached
}

/** `[u, v, du, dv]` — where a glyph sits in the atlas, in texture coordinates. */
export function glyphUV(atlas: Atlas, name: string | undefined): [number, number, number, number] {
  const i = name === undefined ? -1 : (atlas.index[name] ?? -1)
  if (i < 0) return [0, 0, 0, 0]
  const col = i % atlas.cols
  const row = Math.floor(i / atlas.cols)
  return [col / atlas.cols, row / atlas.rows, 1 / atlas.cols, 1 / atlas.rows]
}

/**
 * One glyph as a white-on-transparent data URL, for the layer panel.
 *
 * The legend and the map have to agree about what a mark looks like, and the
 * only way to guarantee that is for both to come from the same atlas — a second
 * set of icons drawn for the panel is a second set that can drift, which is the
 * argument layerPanel.ts already makes about the colour ramp.
 *
 * White rather than the layer's colour: the swatch sits beside the ramp that
 * carries the colour, so tinting it here would say the same thing twice.
 */
const urlCache = new Map<string, string>()

export function glyphDataUrl(name: string | undefined): string | null {
  if (!name) return null
  const hit = urlCache.get(name)
  if (hit !== undefined) return hit

  const atlas = buildAtlas()
  const i = atlas.index[name]
  if (i === undefined) return null

  const c = document.createElement('canvas')
  c.width = atlas.cell
  c.height = atlas.cell
  const ctx = c.getContext('2d')
  if (!ctx) return null

  const col = i % atlas.cols
  const row = Math.floor(i / atlas.cols)
  ctx.drawImage(atlas.canvas, col * atlas.cell, row * atlas.cell, atlas.cell, atlas.cell, 0, 0, atlas.cell, atlas.cell)

  // GREEN is the body; everything becomes white at that coverage.
  const img = ctx.getImageData(0, 0, atlas.cell, atlas.cell)
  for (let k = 0; k < img.data.length; k += 4) {
    const body = img.data[k + 1]!
    img.data[k] = 255
    img.data[k + 1] = 255
    img.data[k + 2] = 255
    img.data[k + 3] = body
  }
  ctx.putImageData(img, 0, 0)

  const url = c.toDataURL('image/png')
  urlCache.set(name, url)
  return url
}
