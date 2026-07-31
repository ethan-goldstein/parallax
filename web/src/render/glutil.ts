// ── web/src/render/glutil.ts ────────────────────────────────────────────────
// The smallest amount of WebGL2 boilerplate the point layer needs.
//
// This exists because MapLibre hands custom layers a raw `WebGL2RenderingContext`
// and nothing else. There is no scene graph and no material system, which is the
// point — the previous renderer went through three.js to reach the same three
// calls, and the abstraction was the only thing standing between the wasm heap
// and `bufferSubData`.
//
// Shader compilation failures are thrown, never logged and swallowed. A custom
// layer whose program failed to link renders nothing at all, which on a map that
// still shows a basemap looks exactly like "the feed returned no data" — the
// most expensive possible way to fail.
// ────────────────────────────────────────────────────────────────────────────

export class ShaderError extends Error {
  constructor(
    message: string,
    readonly stage: 'vertex' | 'fragment' | 'link',
    readonly log: string,
  ) {
    super(message)
    this.name = 'ShaderError'
  }
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const stage = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'
  const shader = gl.createShader(type)
  if (!shader) throw new ShaderError(`could not create ${stage} shader`, stage, '')

  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '(no log)'
    gl.deleteShader(shader)
    // The prelude is spliced in above our source, so reported line numbers do
    // not match the .glsl file. Say so rather than letting someone hunt for a
    // line 214 in a 60-line shader.
    throw new ShaderError(
      `${stage} shader failed to compile (line numbers include MapLibre's injected projection prelude)`,
      stage,
      log,
    )
  }
  return shader
}

/** Compiles and links a program. Throws {@link ShaderError} on any failure. */
export function buildProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vertexSource)
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)

  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    throw new ShaderError('could not create program', 'link', '')
  }

  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)

  // Shaders are reference-counted by the program once attached, so detaching
  // and deleting here is correct and keeps the driver's shader table small.
  gl.detachShader(program, vs)
  gl.detachShader(program, fs)
  gl.deleteShader(vs)
  gl.deleteShader(fs)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? '(no log)'
    gl.deleteProgram(program)
    throw new ShaderError('program failed to link', 'link', log)
  }
  return program
}

/** Uniform locations, looked up once per program rather than per frame. */
export function uniformLocations<K extends string>(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  names: readonly K[],
): Record<K, WebGLUniformLocation | null> {
  const out = {} as Record<K, WebGLUniformLocation | null>
  for (const name of names) out[name] = gl.getUniformLocation(program, name)
  return out
}

/** `0xRRGGBB` to linear-ish 0..1 RGB, matching what the old three.js path fed the shader. */
export function rgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255]
}
