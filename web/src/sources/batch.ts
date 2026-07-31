// ── web/src/sources/batch.ts ────────────────────────────────────────────────
// The two things every source needs and none of them owns.
//
// Both used to live in usgs.ts, which meant emsc.ts and digitraffic.ts imported
// from usgs.ts to get them. That put a dependency edge between sibling sources
// which have nothing to do with each other, and it would have made USGS an
// import target for all fifteen.
// ────────────────────────────────────────────────────────────────────────────
import type { FactInput } from '../engine/engine'

/**
 * One transaction's worth of facts.
 *
 * `wallClockUnix` is the SYSTEM-time instant — when this became known, not when
 * it happened. Valid time rides on each fact's `validFrom`. Keeping them apart
 * at the boundary is what lets the scheduler order batches globally without
 * touching what any of them mean.
 */
export interface Batch {
  wallClockUnix: number
  facts: FactInput[]
}

/**
 * Stable numeric ids for the string keys sources use to name things.
 *
 * Deliberately NOT namespaced per source. USGS and EMSC mint different ids for
 * the same physical earthquake, and that collision surviving into the store is
 * precisely the duplicate problem entity resolution exists to solve. Prefixing
 * keys per source would hide it.
 */
export class EntityRegistry {
  #ids = new Map<string, number>()
  #next = 0

  idFor(key: string): number {
    let id = this.#ids.get(key)
    if (id === undefined) {
      id = this.#next++
      this.#ids.set(key, id)
    }
    return id
  }

  get size(): number {
    return this.#next
  }

  labelOf(entity: number): string | undefined {
    for (const [k, v] of this.#ids) if (v === entity) return k
    return undefined
  }
}

/**
 * Groups records into one transaction per time bucket, ascending.
 *
 * Every source repeats this shape: bucket by the record's SYSTEM time, emit
 * facts per record, return batches oldest-first. It was copied three times
 * before this existed and would have been copied seven more.
 *
 * The bucket matters. One transaction per record would mint thousands of
 * TxnIds and make the scrubber's system axis a smear of single-fact steps;
 * one transaction for everything would collapse the axis to a point. A minute
 * is the resolution at which "what did we know" is a question worth asking.
 *
 * `systemTimeOf` must return UNIX SECONDS of when the record became known —
 * not when the thing happened. Passing valid time here is the mistake that
 * silently flattens the store onto its diagonal.
 */
export function bucketBatches<T>(
  records: readonly T[],
  systemTimeOf: (r: T) => number,
  emit: (record: T, push: (f: FactInput) => void) => void,
  bucketSeconds = 60,
): Batch[] {
  const byBucket = new Map<number, T[]>()
  for (const r of records) {
    const bucket = Math.floor(systemTimeOf(r) / bucketSeconds) * bucketSeconds
    const list = byBucket.get(bucket)
    if (list) list.push(r)
    else byBucket.set(bucket, [r])
  }

  return [...byBucket.keys()]
    .sort((a, b) => a - b)
    .map((bucket) => {
      const facts: FactInput[] = []
      const push = (f: FactInput): void => {
        facts.push(f)
      }
      for (const r of byBucket.get(bucket)!) emit(r, push)
      return { wallClockUnix: bucket, facts }
    })
}
