// ── web/src/engine/abi.ts ───────────────────────────────────────────────────
// Hand-mirrored from engine/include/px/wire.hpp.
//
// There is no code generation here, which is a deliberate trade: a generator
// would be more machinery than this project needs for two structs. The safety
// net is on the C++ side — every offset and size below is pinned by a
// static_assert in wire.hpp, so changing a field there fails the build rather
// than silently misaligning reads here.
//
// If you edit one file, edit the other in the same commit. A mismatch does not
// throw; it renders wrong numbers on a globe.
// ────────────────────────────────────────────────────────────────────────────

/** px::Kind — the value type tag. Must match the enum in px/value.hpp. */
export const Kind = {
  Null: 0,
  Bool: 1,
  I64: 2,
  F64: 3,
  Sym: 4,
  Geo: 5,
  Time: 6,
  Ref: 7,
} as const

// ── wire::Fact (32 bytes) ──────────────────────────────────────────────────
// Field order is by descending alignment so the struct packs with no interior
// padding. Written naively (u8 first) it would be 40 bytes.

export const FACT_SIZE = 32
export const FACT_OFF = {
  vbits: 0, // u64
  entity: 8, // u32
  attr: 12, // u32
  validFrom: 16, // i32
  validTo: 20, // i32
  source: 24, // u16
  vkind: 26, // u8
  reserved: 27, // u8
} as const

// ── wire::Point (16 bytes) ─────────────────────────────────────────────────
// A clean vec4 stride, fed straight to a Three.js InstancedBufferAttribute.

export const POINT_SIZE = 16
export const POINT_FLOATS = 4 // lat, lon, scalar, (fact_id reinterpreted)
export const POINT_OFF = {
  lat: 0, // f32
  lon: 4, // f32
  scalar: 8, // f32
  factId: 12, // u32
} as const

// ── time ───────────────────────────────────────────────────────────────────
// px::Timestamp is i32 seconds since 2000-01-01T00:00:00Z. See px/value.hpp
// for why 32-bit: it halves the bytes the visibility predicate has to read,
// and that scan is memory-bound.

export const EPOCH_UNIX = 946_684_800
export const TIME_MIN = -2_147_483_647
export const TIME_MAX = 2_147_483_647

/** "still true" / "still believed" sentinels. */
export const OPEN_VALID = TIME_MAX

export function toTimestamp(unixSeconds: number): number {
  const t = Math.round(unixSeconds) - EPOCH_UNIX
  if (t < TIME_MIN) return TIME_MIN
  if (t > TIME_MAX) return TIME_MAX
  return t
}

export function fromTimestamp(t: number): number {
  return t + EPOCH_UNIX
}

// ── geo packing ────────────────────────────────────────────────────────────
// Latitude and longitude as degrees x 1e7, two i32 packed into the 8-byte
// payload: lat in the high word, lon in the low word. Mirrors Value::geo().

export const GEO_SCALE = 1e7

/**
 * Writes a packed GeoPoint into the 8 bytes at `offset`.
 *
 * Written as two 32-bit stores rather than one BigInt64 store on purpose.
 * Building a BigInt per record would allocate on every point — tens of
 * thousands per feed refresh — and the whole reason this buffer exists is to
 * avoid per-record allocation.
 */
export function writeGeo(view: DataView, offset: number, lat: number, lon: number): void {
  const latClamped = Math.max(-90, Math.min(90, lat))
  let lonWrapped = lon
  while (lonWrapped > 180) lonWrapped -= 360
  while (lonWrapped < -180) lonWrapped += 360

  const latE7 = Math.round(latClamped * GEO_SCALE) | 0
  const lonE7 = Math.round(lonWrapped * GEO_SCALE) | 0

  // Little-endian, and the high word (lat) sits at the higher address.
  // WebAssembly is little-endian by specification, so this is not a portability
  // assumption — it is the platform's guarantee.
  view.setInt32(offset, lonE7, true)
  view.setInt32(offset + 4, latE7, true)
}

/** Writes an f64 payload, mirroring Value::real()'s bit_cast. */
export function writeF64Bits(view: DataView, offset: number, value: number): void {
  view.setFloat64(offset, value, true)
}

/** Writes an i64 payload, mirroring Value::integer(). */
export function writeI64Bits(view: DataView, offset: number, value: number): void {
  // Number cannot represent the full i64 range exactly beyond 2^53, but every
  // integer this project stores (counts, ids, depths) is far inside that.
  view.setBigInt64(offset, BigInt(Math.trunc(value)), true)
}

/**
 * Writes one wire::Fact at `recordIndex` into a staging DataView.
 *
 * The caller supplies the already-encoded 8-byte payload via a writer callback
 * so this function never has to branch on Kind, and so a caller adding a new
 * value type does not have to edit it.
 */
export function writeFact(
  view: DataView,
  recordIndex: number,
  fact: {
    entity: number
    attr: number
    kind: number
    validFrom: number
    validTo: number
    source: number
    writePayload: (v: DataView, offset: number) => void
  },
): void {
  const base = recordIndex * FACT_SIZE

  fact.writePayload(view, base + FACT_OFF.vbits)
  view.setUint32(base + FACT_OFF.entity, fact.entity, true)
  view.setUint32(base + FACT_OFF.attr, fact.attr, true)
  view.setInt32(base + FACT_OFF.validFrom, fact.validFrom, true)
  view.setInt32(base + FACT_OFF.validTo, fact.validTo, true)
  view.setUint16(base + FACT_OFF.source, fact.source, true)
  view.setUint8(base + FACT_OFF.vkind, fact.kind)
  view.setUint8(base + FACT_OFF.reserved, 0)
}
