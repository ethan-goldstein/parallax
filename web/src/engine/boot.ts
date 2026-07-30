// ── web/src/engine/boot.ts ──────────────────────────────────────────────────
// Instantiates the WebAssembly module. Small file, three non-obvious details,
// each of which fails in a way that does not name its own cause.
// ────────────────────────────────────────────────────────────────────────────

/** The embind surface, mirrored by hand from bindings/wasm/px_wasm.cpp. */
export interface ParallaxModule {
  version(): string
  buildTarget(): string
  hasSimd(): boolean

  // Emscripten runtime pieces. Only web/src/engine/heap.ts may touch these —
  // they are typed here so that rule is enforceable rather than aspirational.
  HEAPU8: Uint8Array
  HEAP32: Int32Array
  HEAPU32: Uint32Array
  HEAPF32: Float32Array
  HEAPF64: Float64Array
  _malloc(bytes: number): number
  _free(ptr: number): void
  onmemorygrowth?: () => void
}

type ModuleFactory = (opts?: {
  locateFile?: (path: string) => string
}) => Promise<ParallaxModule>

/**
 * WASM SIMD has shipped in every major browser since Safari 16.4 (March 2023)
 * and the engine is compiled with -msimd128 unconditionally, so a browser
 * without it cannot run PARALLAX at all. Detecting it up front turns that into
 * one readable sentence instead of an unhandled RuntimeError from deep inside
 * the glue.
 *
 * The payload is the probe module from wasm-feature-detect: a function typed
 * to return v128 (0x7b) whose body uses the 0xFD SIMD opcode prefix. Both the
 * type and the opcode are rejected by a validator without SIMD support, so
 * WebAssembly.validate answers the question without instantiating anything.
 *
 * Do not hand-assemble a replacement. An invalid module validates false on
 * every browser, so a mistake here does not look like a bug — it looks like
 * universal lack of support, and it locks everyone out of the application with
 * a confident, wrong explanation.
 */
const SIMD_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00,
  0x01, 0x7b, 0x03, 0x02, 0x01, 0x00, 0x0a, 0x0a, 0x01, 0x08, 0x00, 0x41, 0x00,
  0xfd, 0x0f, 0xfd, 0x62, 0x0b,
])

function supportsSimd(): boolean {
  try {
    return WebAssembly.validate(SIMD_PROBE)
  } catch {
    return false
  }
}

export class EngineBootError extends Error {
  constructor(
    message: string,
    readonly cause_?: unknown,
  ) {
    super(message)
    this.name = 'EngineBootError'
  }
}

let cached: Promise<ParallaxModule> | undefined

/**
 * Loads and instantiates the engine. Idempotent — repeated calls share one
 * instance, because two WASM modules would mean two disjoint heaps and a
 * selection bitset that silently refers to the wrong one.
 */
export function bootEngine(): Promise<ParallaxModule> {
  cached ??= boot()
  return cached
}

async function boot(): Promise<ParallaxModule> {
  if (!supportsSimd()) {
    throw new EngineBootError(
      'This browser does not support WebAssembly SIMD, which PARALLAX requires. ' +
        'Chrome 91+, Firefox 89+, Safari 16.4+, or Edge 91+ will work.',
    )
  }

  // BASE_URL is '/parallax/' in production and '/' in dev. Building the URL
  // from it rather than hardcoding either one is what lets the same code path
  // work in both, and `vite preview` is the only local mode that exercises the
  // production value.
  //
  // @vite-ignore is required: the specifier is computed, and without it Rollup
  // attempts to analyse the emscripten glue at build time and fails on its
  // conditional Node requires.
  const glueUrl = `${import.meta.env.BASE_URL}wasm/parallax.js`

  let factory: ModuleFactory
  try {
    const mod = (await import(/* @vite-ignore */ glueUrl)) as { default: ModuleFactory }
    factory = mod.default
  } catch (err) {
    throw new EngineBootError(`Could not load the engine glue from ${glueUrl}`, err)
  }

  try {
    return await factory({
      // Without this the glue resolves parallax.wasm relative to the document,
      // not to itself. Under a project subpath that is a 404 — which the
      // browser surfaces as a WASM *compile* error, sending you to debug the
      // C++ instead of the URL. This one line is the difference.
      locateFile: (path: string) => `${import.meta.env.BASE_URL}wasm/${path}`,
    })
  } catch (err) {
    throw new EngineBootError('The engine failed to instantiate', err)
  }
}
