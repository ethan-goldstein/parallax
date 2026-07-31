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

export interface QueryResult {
  buffer: BufferRef
  ok: boolean
  error: string
  errorBegin: number
  errorEnd: number
  /** EXPLAIN record as JSON — small and human-readable, which is exactly when
   *  JSON across the boundary is the right call. */
  explain: string

  /** A policy refusal, reported separately from `error` — a denial is a
   *  result, not a syntax problem. */
  denied: boolean
  ruleId: string
  denialExplanation: string
  denialOffending: string
  denialRemedy: string
}

export interface ErStats {
  records: number
  pairsCompared: number
  pairsAccepted: number
  clusters: number
  mergedRecords: number
  blocksSkipped: number
  elapsedMs: number
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
  registerSource(name: string, geoAttr: number, scalarAttr: number): void
  runQuery(sql: string, nowUnix: number): QueryResult
  runQueryAt(
    sql: string,
    nowUnix: number,
    validAt: number,
    sysAt: number,
    record: boolean,
  ): QueryResult
  setPurpose(name: string): boolean
  setSensitivity(attr: number, level: number): void
  auditLog(limit: number): string
  finishIngest(): void
  resolveEntities(geoAttr: number, scalarAttr: number): ErStats
  mergeEvidence(limit: number): string
  inspect(
    lat: number,
    lon: number,
    radiusM: number,
    validAt: number,
    sysAt: number,
    geoAttrs: string,
  ): string
  unmergePair(pairIndex: number): void
  benchScan(iterations: number): unknown
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

  /**
   * Binds a query-language source name to the attributes carrying its geometry
   * and scalar. `earthquakes` and `vessels` are distinct sources precisely
   * because they answer to different attributes.
   */
  registerSource(name: string, geoAttr: number, scalarAttr: number): void {
    this.#x.registerSource(name, geoAttr, scalarAttr)
  }

  /**
   * Parses, plans, executes, and packs a query for rendering.
   *
   * `nowUnix` is injected rather than read from a clock inside the engine, so
   * relative times like `-6h` resolve against a caller-controlled instant and
   * plans stay reproducible.
   */
  runQuery(sql: string, nowUnix = Math.floor(Date.now() / 1000)): QueryResult {
    return this.#x.runQuery(sql, nowUnix)
  }

  /**
   * The same query, pinned to the scrubber's two axes.
   *
   * `sysAt` is a transaction INDEX, passed straight through. Expressing the same
   * thing by appending `as of … @ …` to the SQL would be lossy: that clause
   * takes a wall clock, and several transactions routinely share one second —
   * every live feed lands in the same minute bucket — so the engine would
   * resolve back to the last of them rather than the one selected.
   *
   * `record: false` suppresses only the audit write, never the policy check. A
   * scrubber drag is one question being explored at sixty instants a second; a
   * trail with sixty identical entries answers nothing.
   */
  runQueryAt(
    sql: string,
    validAt: number,
    sysAt: number,
    record = true,
    nowUnix = Math.floor(Date.now() / 1000),
  ): QueryResult {
    return this.#x.runQueryAt(sql, nowUnix, validAt, sysAt, record)
  }

  /**
   * Declares why this session is querying.
   *
   * Returns false for an unknown purpose rather than defaulting to something
   * permissive — a typo must not silently widen access.
   */
  setPurpose(name: string): boolean {
    return this.#x.setPurpose(name)
  }

  /** 0 = public, 1 = precise, 2 = person-linked. */
  setSensitivity(attr: number, level: 0 | 1 | 2): void {
    this.#x.setSensitivity(attr, level)
  }

  /** The audit trail, read back out of the bitemporal store. */
  auditLog(limit = 50): string {
    return this.#x.auditLog(limit)
  }

  /**
   * Rebuilds every index. Call ONCE after the last ingest batch.
   *
   * Doing this per batch is quadratic in the batch count — it measured 9.7 s
   * across 2,841 transactions. Correctness does not depend on calling it:
   * stale indexes degrade to scans, never to wrong answers.
   */
  finishIngest(): void {
    this.#x.finishIngest()
  }

  /**
   * Runs entity resolution over everything carrying `geoAttr`.
   *
   * Records are rebuilt from the store rather than from the feed clients, so
   * resolution sees exactly what was ingested — including each fact's source,
   * which the model needs because same-source pairs are never merged.
   */
  resolveEntities(geoAttr: number, scalarAttr: number): ErStats {
    return this.#x.resolveEntities(geoAttr, scalarAttr)
  }

  /** Per-merge evidence as JSON — the derivation, not a summary. */
  mergeEvidence(limit = 25): string {
    return this.#x.mergeEvidence(limit)
  }

  /**
   * Identifies the nearest visible point to a position, as JSON.
   *
   * `geoAttrs` is a comma-separated list of the geometry attribute ids the
   * caller is currently DISPLAYING. The engine has no notion of a layer being
   * switched off, so the view has to say — pass an empty string to accept any
   * geometry.
   *
   * Note this takes a position, not a fact id: the engine picks the row itself,
   * which keeps its unchecked row accessors unreachable from here.
   */
  inspect(
    lat: number,
    lon: number,
    radiusM: number,
    validAt: number,
    sysAt: number,
    geoAttrs: string,
  ): string {
    return this.#x.inspect(lat, lon, radiusM, validAt, sysAt, geoAttrs)
  }

  unmergePair(pairIndex: number): void {
    this.#x.unmergePair(pairIndex)
  }

  /**
   * Times the bitemporal scan with both kernels and returns pointers to the
   * predicate columns, so the caller can run the identical loop in JS over the
   * identical bytes.
   */
  benchScan(iterations = 5): unknown {
    return this.#x.benchScan(iterations)
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
