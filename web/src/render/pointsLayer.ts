// ── web/src/render/pointsLayer.ts ───────────────────────────────────────────
// One instanced point layer, drawn straight out of the wasm heap through
// MapLibre's CustomLayerInterface.
//
// ── why this is not the MapLibre data path ─────────────────────────────────
//
// globe.ts used to carry a comment rejecting MapLibre outright, on the grounds
// that feeding it 100k points means constructing 100k GeoJSON Feature objects
// every refresh. That is true, and it is still true — of `addSource`/`setData`.
//
// A custom layer is a different door. MapLibre hands over its raw
// WebGL2RenderingContext and asks only that we draw inside its frame. The
// engine's Float32Array goes to `bufferSubData` untouched: no Feature objects,
// no per-entity allocation, no intermediate array. That is a shorter path to the
// GPU than the three.js InstancedInterleavedBuffer it replaced, not a longer one.
//
// See docs/decisions/0005 for the full reversal.
// ────────────────────────────────────────────────────────────────────────────
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from 'maplibre-gl'

import { POINT_FLOATS } from '../engine/abi'
import { buildProgram, rgb, uniformLocations } from './glutil'
import FRAGMENT_SOURCE from './shaders/points.frag.glsl?raw'
import VERTEX_BODY from './shaders/points.vert.glsl?raw'

/** Visual identity for one data layer. Unchanged in shape from the three.js era. */
export interface LayerSpec {
  colorLow: number
  colorHigh: number
  /**
   * Base radius in SCREEN PIXELS before the scalar contribution.
   *
   * This unit changed with the renderer. Under three.js the globe had radius 1
   * and sizes were world-space fractions of it, so a point's on-screen size fell
   * out of the camera distance. MapLibre owns the camera now and zoom spans
   * fifteen orders of magnitude, so a world-space size would be invisible at
   * z0 and cover a country at z12.
   */
  sizeBase: number
  /** Additional radius in pixels per unit of the per-point scalar. */
  sizeScale: number
  /** Scalar value mapped to colorLow, and to colorHigh. */
  rampLow: number
  rampHigh: number
  /**
   * Additive reads as energy and is right for seismic, fire and solar layers.
   * It is wrong for asset layers: fifteen overlapping additive layers wash to
   * white, and two vessels in a harbour should not glow brighter than one.
   */
  blend?: 'additive' | 'normal'
}

const UNIFORMS = [
  'u_projection_matrix',
  'u_projection_fallback_matrix',
  'u_projection_tile_mercator_coords',
  'u_projection_clipping_plane',
  'u_projection_transition',
  'u_projection_clip_antimeridian',
  'u_viewport',
  'u_sizeBase',
  'u_sizeScale',
  'u_colorLow',
  'u_colorHigh',
  'u_rampLow',
  'u_rampHigh',
  'u_opacity',
] as const

type Uniforms = Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>

interface Variant {
  program: WebGLProgram
  uniforms: Uniforms
}

/**
 * Compiled programs, one per projection variant, shared by every layer.
 *
 * MapLibre changes `shaderData.variantName` when the projection changes — and
 * during a globe↔mercator transition it changes every frame. Compiling per frame
 * would stall the pipeline, so variants are cached and reused. Because all
 * layers draw with identical shaders and differ only in uniforms, the cache is
 * owned by the map and shared rather than duplicated per layer.
 */
export class PointProgramCache {
  #variants = new Map<string, Variant>()

  get(gl: WebGL2RenderingContext, data: CustomRenderMethodInput['shaderData']): Variant {
    const hit = this.#variants.get(data.variantName)
    if (hit) return hit

    const vertexSource = `#version 300 es
${data.vertexShaderPrelude}
${data.define}
${VERTEX_BODY}`

    const program = buildProgram(gl, vertexSource, `#version 300 es\n${FRAGMENT_SOURCE}`)
    const variant: Variant = { program, uniforms: uniformLocations(gl, program, UNIFORMS) }
    this.#variants.set(data.variantName, variant)
    return variant
  }

  dispose(gl: WebGL2RenderingContext): void {
    for (const v of this.#variants.values()) gl.deleteProgram(v.program)
    this.#variants.clear()
  }
}

/** The static unit quad every instance is drawn from. */
const QUAD = new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1])
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3])

export class PointsLayer implements CustomLayerInterface {
  readonly type = 'custom' as const
  readonly renderingMode = '2d' as const

  visible = true

  #gl: WebGL2RenderingContext | null = null
  #vao: WebGLVertexArrayObject | null = null
  #instanceVbo: WebGLBuffer | null = null
  #quadVbo: WebGLBuffer | null = null
  #indexBuffer: WebGLBuffer | null = null

  #count = 0

  /** Instances currently drawn. Read by the readout and by tests. */
  get count(): number {
    return this.#count
  }

  /**
   * Data that arrived before the GL context existed.
   *
   * A COPY, never the caller's view. The view points into the wasm heap, and
   * holding one across frames is exactly the detachment hazard heap.ts exists to
   * prevent — a heap growth between the refresh and the first render would leave
   * this reading a detached ArrayBuffer. Copying costs one allocation, once, at
   * boot, and only when a refresh beats the style load.
   */
  #pending: Float32Array | null = null

  constructor(
    readonly id: string,
    private readonly spec: LayerSpec,
    private readonly maxPoints: number,
    private readonly programs: PointProgramCache,
  ) {}

  // ── CustomLayerInterface ─────────────────────────────────────────────────

  onAdd(_map: MlMap, gl: WebGL2RenderingContext): void {
    this.#gl = gl

    this.#quadVbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#quadVbo)
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW)

    this.#indexBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.#indexBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, QUAD_INDICES, gl.STATIC_DRAW)

    // Allocated once at full capacity so the GPU buffer is never resized. Same
    // reasoning as the engine's fixed-capacity render buffer: a buffer that
    // never reallocates cannot move underneath something that points at it.
    this.#instanceVbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#instanceVbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.maxPoints * POINT_FLOATS * 4, gl.DYNAMIC_DRAW)

    // One VAO, valid for every projection variant, because the shader pins
    // attribute locations explicitly rather than letting the linker assign them.
    this.#vao = gl.createVertexArray()
    gl.bindVertexArray(this.#vao)

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.#indexBuffer)

    gl.bindBuffer(gl.ARRAY_BUFFER, this.#quadVbo)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.vertexAttribDivisor(0, 0)

    const stride = POINT_FLOATS * 4
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#instanceVbo)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0) // lat, lon
    gl.vertexAttribDivisor(1, 1)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 8) // scalar
    gl.vertexAttribDivisor(2, 1)

    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)

    if (this.#pending) {
      this.#upload(this.#pending, this.#count)
      this.#pending = null
    }
  }

  onRemove(_map: MlMap, gl: WebGL2RenderingContext): void {
    if (this.#vao) gl.deleteVertexArray(this.#vao)
    if (this.#instanceVbo) gl.deleteBuffer(this.#instanceVbo)
    if (this.#quadVbo) gl.deleteBuffer(this.#quadVbo)
    if (this.#indexBuffer) gl.deleteBuffer(this.#indexBuffer)
    this.#vao = null
    this.#instanceVbo = null
    this.#quadVbo = null
    this.#indexBuffer = null
    this.#gl = null
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    if (!this.visible || this.#count === 0 || !this.#vao) return

    const { program, uniforms: u } = this.programs.get(gl, args.shaderData)
    gl.useProgram(program)

    // MapLibre's projection uniforms. The prelude spliced into the vertex shader
    // declares these; projectTile() reads nothing else.
    const p = args.defaultProjectionData
    gl.uniformMatrix4fv(u.u_projection_matrix, false, p.mainMatrix)
    gl.uniformMatrix4fv(u.u_projection_fallback_matrix, false, p.fallbackMatrix)
    gl.uniform4fv(u.u_projection_tile_mercator_coords, p.tileMercatorCoords)
    gl.uniform4fv(u.u_projection_clipping_plane, p.clippingPlane)
    gl.uniform1f(u.u_projection_transition, p.projectionTransition)
    // Antimeridian clipping splits geometry that spans the seam. A point is a
    // single vertex and cannot span anything, so it never applies here.
    gl.uniform1i(u.u_projection_clip_antimeridian, 0)

    gl.uniform2f(u.u_viewport, gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.uniform1f(u.u_sizeBase, this.spec.sizeBase)
    gl.uniform1f(u.u_sizeScale, this.spec.sizeScale)
    gl.uniform3fv(u.u_colorLow, rgb(this.spec.colorLow))
    gl.uniform3fv(u.u_colorHigh, rgb(this.spec.colorHigh))
    gl.uniform1f(u.u_rampLow, this.spec.rampLow)
    gl.uniform1f(u.u_rampHigh, this.spec.rampHigh)
    gl.uniform1f(u.u_opacity, 1.0)

    gl.enable(gl.BLEND)
    gl.blendFunc(
      gl.SRC_ALPHA,
      (this.spec.blend ?? 'additive') === 'additive' ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA,
    )
    // Points are billboards with no meaningful depth against each other, and
    // under globe projection gl_Position.z carries a horizon distance rather
    // than a depth — testing it against the depth buffer would be nonsense.
    gl.disable(gl.DEPTH_TEST)
    gl.depthMask(false)

    gl.bindVertexArray(this.#vao)
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this.#count)
    gl.bindVertexArray(null)

    // MapLibre shares this context and sets most state per draw, but it does not
    // reset blendFunc. Leaving SRC_ALPHA/ONE set makes the next layer's
    // translucent fills glow.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  // ── data ─────────────────────────────────────────────────────────────────

  /**
   * Points the layer at a fresh view over the wasm heap.
   *
   * `view` must be re-derived from Heap on every call and never cached by the
   * caller — that rule is unchanged from the three.js renderer and is still the
   * load-bearing invariant. What changed is that it is now easier to honour:
   * the bytes are copied to the GPU before this returns, so nothing retains a
   * reference that a heap growth could detach.
   */
  setData(view: Float32Array, count: number): void {
    const clamped = Math.min(count, this.maxPoints)
    this.#count = clamped

    if (!this.#gl) {
      this.#pending = clamped > 0 ? view.slice(0, clamped * POINT_FLOATS) : null
      return
    }
    this.#upload(view, clamped)
  }

  #upload(view: Float32Array, count: number): void {
    const gl = this.#gl
    if (!gl || !this.#instanceVbo || count === 0) return
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#instanceVbo)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, view, 0, count * POINT_FLOATS)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
  }
}
