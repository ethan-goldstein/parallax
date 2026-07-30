// ── web/src/engine/heap.ts ──────────────────────────────────────────────────
// THE ONLY FILE IN THE CODEBASE ALLOWED TO TOUCH WASM HEAP VIEWS.
//
// Everything about this module exists to defend against one failure mode that
// is uniquely nasty because it is completely silent:
//
//   When the WASM heap grows, every ArrayBuffer JavaScript is holding over it
//   is DETACHED. No exception is thrown. No warning is logged. The typed array
//   simply reports byteLength === 0 from then on: reads return undefined,
//   writes go nowhere, and the symptom appears somewhere else entirely — an
//   empty globe, a zeroed buffer, a NaN in a shader.
//
// There is a second, distinct hazard that is often conflated with it: the
// engine reallocating a buffer *without* the heap growing. The address moves
// even though every JS view is still technically valid, so reads silently
// return stale or unrelated memory.
//
// Four mechanisms, all of them necessary, none of them sufficient alone:
//
//   1. INITIAL_MEMORY is pre-grown to 256 MB (see bindings/wasm/CMakeLists),
//      so growth essentially never happens after boot.
//   2. No typed array is ever cached across an engine call. Every accessor
//      below re-reads Module.HEAPF32 et al. at the moment of use.
//   3. The engine bumps a generation counter on any reallocation. We compare
//      it and drop cached views on mismatch, turning silent corruption into a
//      detectable event.
//   4. Module.onmemorygrowth bumps a local epoch, catching growth we did not
//      cause.
//
// The discipline that makes this work is that no other file imports Module and
// reaches for a heap view. If you find yourself wanting to, add an accessor
// here instead.
// ────────────────────────────────────────────────────────────────────────────
import type { ParallaxModule } from './boot'
import { POINT_SIZE } from './abi'

export interface BufferRef {
  ptr: number
  count: number
  stride: number
  generation: number
  truncated: number
}

export class HeapAccessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HeapAccessError'
  }
}

export class Heap {
  #module: ParallaxModule
  #epoch = 0

  // Cached view for the render path, keyed by everything that could invalidate
  // it. Rebuilding a Float32Array wrapper 60 times a second is not free, and
  // the entire point of the zero-copy design is to allocate nothing per frame.
  #pointView: Float32Array | null = null
  #pointKey = ''

  constructor(module: ParallaxModule) {
    this.#module = module

    // Growth we did not initiate — an allocation deep inside the engine, for
    // instance. Without this hook the first symptom would be a blank globe.
    module.onmemorygrowth = () => {
      this.#epoch++
      this.#pointView = null
      console.warn('[parallax] wasm heap grew; all cached heap views invalidated')
    }
  }

  /** Bumped on heap growth. Combined with the engine's generation counter it
   *  covers both invalidation causes. */
  get epoch(): number {
    return this.#epoch
  }

  /**
   * A Float32Array over `count * 4` floats at `ptr`.
   *
   * Never store the result. Call this again after any engine call — that is
   * cheap, and it is the rule that makes detachment impossible to observe.
   */
  viewF32(ptr: number, floatCount: number): Float32Array {
    const heap = this.#module.HEAPF32
    if (heap.byteLength === 0) {
      throw new HeapAccessError(
        'HEAPF32 is detached — the heap grew while a view was held. This is a bug in the caller, not the engine.',
      )
    }
    const start = ptr >>> 2
    if (ptr % 4 !== 0) {
      throw new HeapAccessError(`pointer ${ptr} is not 4-byte aligned for a f32 view`)
    }
    if (start + floatCount > heap.length) {
      throw new HeapAccessError(
        `f32 view [${start}, ${start + floatCount}) exceeds heap length ${heap.length}`,
      )
    }
    return heap.subarray(start, start + floatCount)
  }

  viewU8(ptr: number, byteCount: number): Uint8Array {
    const heap = this.#module.HEAPU8
    if (heap.byteLength === 0) {
      throw new HeapAccessError('HEAPU8 is detached — the heap grew while a view was held.')
    }
    if (ptr + byteCount > heap.length) {
      throw new HeapAccessError(
        `u8 view [${ptr}, ${ptr + byteCount}) exceeds heap length ${heap.length}`,
      )
    }
    return heap.subarray(ptr, ptr + byteCount)
  }

  /**
   * A DataView for WRITING into the staging buffer.
   *
   * DataView rather than a typed array because wire::Fact is a mixed-type
   * packed struct: u64, u32, i32, u16, u8 at fixed offsets. A DataView reads
   * and writes each at its natural offset with an explicit endianness, which
   * is exactly what mirroring a C struct requires.
   */
  stagingView(ptr: number, byteCount: number): DataView {
    const heap = this.#module.HEAPU8
    if (heap.byteLength === 0) {
      throw new HeapAccessError('HEAPU8 is detached before a staging write.')
    }
    if (ptr + byteCount > heap.length) {
      throw new HeapAccessError(
        `staging range [${ptr}, ${ptr + byteCount}) exceeds heap length ${heap.length}`,
      )
    }
    return new DataView(heap.buffer, ptr, byteCount)
  }

  /**
   * The render buffer as interleaved floats, cached until something
   * invalidates it.
   *
   * The cache key includes the engine's generation and the local growth epoch,
   * so any reallocation on either side of the boundary rebuilds the view
   * rather than silently returning one that points at the wrong memory.
   */
  pointView(ref: BufferRef): Float32Array {
    if (ref.stride !== POINT_SIZE) {
      throw new HeapAccessError(
        `stride mismatch: engine says ${ref.stride}, abi.ts says ${POINT_SIZE}. ` +
          'wire.hpp and abi.ts have drifted — fix both in the same commit.',
      )
    }

    const key = `${ref.ptr}:${ref.count}:${ref.generation}:${this.#epoch}`
    if (this.#pointView !== null && this.#pointKey === key) return this.#pointView

    this.#pointView = this.viewF32(ref.ptr, ref.count * 4)
    this.#pointKey = key
    return this.#pointView
  }
}
