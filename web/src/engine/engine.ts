// ── web/src/engine/engine.ts ────────────────────────────────────────────────
// Typed façade over the embind surface.
//
// The raw Module is untyped and its methods are easy to call in the wrong
// order (ingest before stagingPtr, query before init). This wraps it in an API
// where the wrong order is hard to express, and it is the only consumer of
// Heap outside the render path.
// ────────────────────────────────────────────────────────────────────────────
import { FACT_SIZE, writeFact } from './abi'
import type { ParallaxModule } from './boot'
import { Heap, type BufferRef } from './heap'

export interface ScanStats {
  chunksTotal: number
  chunksSkipped: number
  rowsScanned: number
  rowsMatched: number
  queryMs: number
}

export interface IngestResult {
  accepted: number
  rejected: number
  txn: number
}

/** One fact, before it is packed into the staging buffer. */
export interface FactInput {
  entity: number
  attr: number
  kind: number
  validFrom: number
  validTo: number
  source: number
  writePayload: (view: DataView, offset: number) => void
}

export interface Transaction {
  id: number
  wallClockUnix: number
  factCount: number
}

/** The embind surface. Mirrors EMSCRIPTEN_BINDINGS in px_wasm.cpp. */
interface EngineExports {
  version(): string
  buildTarget(): string
  hasSimd(): boolean
  init(maxPoints: number): void
  intern(s: string): number
  stagingPtr(bytes: number): number
  ingest(byteOffset: number, byteLen: number, wallClockUnix: number): IngestResult
  queryPoints(validAt: number, sysAt: number, geoAttr: number, scalarAttr: number): BufferRef
  lastScan(): ScanStats
  factCount(): number
  txnCount(): number
  currentTxn(): number
  generation(): number
  heapBytes(): number
  txnWallClock(i: number): number
  txnFactCount(i: number): number
}

export class Engine {
  readonly heap: Heap
  #x: EngineExports
  #symbols = new Map<string, number>()

  constructor(module: ParallaxModule, maxPoints = 262_144) {
    this.#x = module as unknown as EngineExports
    this.heap = new Heap(module)
    this.#x.init(maxPoints)
  }

  get version(): string {
    return this.#x.version()
  }
  get buildTarget(): string {
    return this.#x.buildTarget()
  }
  get hasSimd(): boolean {
    return this.#x.hasSimd()
  }
  get factCount(): number {
    return this.#x.factCount()
  }
  get txnCount(): number {
    return this.#x.txnCount()
  }
  get currentTxn(): number {
    return this.#x.currentTxn()
  }
  get heapBytes(): number {
    return this.#x.heapBytes()
  }

  /**
   * Interns an attribute name, memoised on the JS side.
   *
   * The engine already deduplicates, so this cache saves a boundary crossing
   * rather than a duplicate symbol. That matters because attribute names
   * repeat on literally every record — interning inside the encode loop would
   * be one embind call per field per record.
   */
  intern(name: string): number {
    let id = this.#symbols.get(name)
    if (id === undefined) {
      id = this.#x.intern(name)
      this.#symbols.set(name, id)
    }
    return id
  }

  /**
   * Packs `facts` into the staging buffer and ingests them as one transaction.
   *
   * The pointer is re-read immediately before the writes and never held across
   * the ingest call, which is the rule that makes staging-buffer growth safe.
   */
  ingest(facts: readonly FactInput[], wallClockUnix: number): IngestResult {
    if (facts.length === 0) return { accepted: 0, rejected: 0, txn: this.currentTxn }

    const bytes = facts.length * FACT_SIZE
    const ptr = this.#x.stagingPtr(bytes)
    const view = this.heap.stagingView(ptr, bytes)

    for (let i = 0; i < facts.length; i++) {
      writeFact(view, i, facts[i]!)
    }

    // Offset 0: the engine's ingest takes an offset into the staging buffer,
    // not an address, and we always fill from the start.
    return this.#x.ingest(0, bytes, wallClockUnix)
  }

  /**
   * The bitemporal slice, packed for rendering.
   *
   * `validAt` and `sysAt` are the two scrubber axes: what was true at T, as
   * believed at transaction S.
   */
  queryPoints(validAt: number, sysAt: number, geoAttr: number, scalarAttr: number): BufferRef {
    return this.#x.queryPoints(validAt, sysAt, geoAttr, scalarAttr)
  }

  lastScan(): ScanStats {
    return this.#x.lastScan()
  }

  /** Every transaction, for labelling the system-time axis. */
  transactions(): Transaction[] {
    const n = this.txnCount
    const out: Transaction[] = []
    for (let i = 0; i < n; i++) {
      out.push({
        id: i,
        wallClockUnix: this.#x.txnWallClock(i),
        factCount: this.#x.txnFactCount(i),
      })
    }
    return out
  }
}
