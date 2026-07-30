// ── px/wire.hpp ─────────────────────────────────────────────────────────────
// The binary layouts shared across the JS<->WASM boundary.
//
// This file is mirrored BY HAND in web/src/engine/abi.ts. There is no code
// generation, which means a change here that is not made there produces
// silently misaligned reads — no crash, no exception, just wrong numbers on a
// globe. The static_asserts at the bottom are the defence: they pin every
// offset and size, so a layout change that would break the mirror fails the
// build instead of the demo. Change one side, and the other side's constants
// must change in the same commit.
//
// ── why a binary staging buffer rather than embind ─────────────────────────
//
// Live feeds arrive as JSON. Parsing JSON in C++ would mean writing or
// vendoring a parser, and pushing 30k records across embind one call at a time
// costs a round trip each. Instead TypeScript — where JSON parsing is native
// and free — normalises records into a flat, fixed-layout buffer that C++
// already owns, and hands over a pointer and a length.
//
// One copy, on the JS side, into memory the engine allocated. For 30k AIS
// positions that is under a megabyte and sub-millisecond.
//
// That division is also the honest answer to "why not do everything in C++?":
// parsing belongs where the format is native, analytics belong where the
// memory layout matters.
// ────────────────────────────────────────────────────────────────────────────
#pragma once

#include "px/ids.hpp"
#include "px/prelude.hpp"
#include "px/value.hpp"

namespace px::wire {

/// One fact, as it crosses from JavaScript into the engine.
///
/// Field order is by descending alignment so the struct packs with no interior
/// padding: the 8-byte payload first, then the 4-byte fields, then the small
/// ones. Laid out naively (u8 first) this would be 40 bytes instead of 32.
///
/// `attr` is a SymbolId, already interned by TS through the engine's own
/// symbol table before the batch is built. Interning per record inside the
/// ingest loop would mean a hash lookup per field name, and attribute names
/// repeat on every single record.
struct Fact {
  u64 vbits;          // 0
  u32 entity;         // 8   EntityId
  u32 attr;           // 12  SymbolId
  i32 valid_from;     // 16  seconds since kEpoch
  i32 valid_to;       // 20  exclusive; kOpenValid for "still true"
  u16 source;         // 24  SourceId
  u8 vkind;           // 26  Kind
  u8 reserved;        // 27  keeps the tail explicit rather than implied padding
};

/// One renderable point, as it crosses from the engine back out to WebGL.
///
/// Degrees as f32, not the stored fixed-point integers: this buffer is fed
/// straight to a Three.js InstancedBufferAttribute, and the shader wants
/// floats. f32 gives about 1 m of precision at global scale, which is far
/// below one screen pixel until you are zoomed further in than this view goes.
///
/// 16 bytes is one quarter of a cache line and a clean vec4 stride.
struct Point {
  f32 lat;       // 0
  f32 lon;       // 4
  f32 scalar;    // 8   magnitude, altitude, speed — whatever the layer maps to size
  u32 fact_id;   // 12  picking: click a dot, get the fact, get its provenance
};

/// Returned by any call that fills an engine-owned buffer.
///
/// `generation` is the anti-dangling mechanism. The engine bumps it whenever a
/// buffer is reallocated or the WASM heap grows; TypeScript re-derives its
/// typed-array view whenever the value changes. Without it, heap growth
/// detaches every cached ArrayBuffer and reads start returning undefined with
/// no error raised anywhere — see web/src/engine/heap.ts.
///
/// `truncated` exists because result buffers are allocated once at capacity
/// and never grow mid-frame. A query that would overflow returns what fits and
/// says so, rather than reallocating under a pointer the caller is holding.
struct BufferRef {
  u32 ptr;            // 0   byte offset into the WASM heap
  u32 count;          // 4   elements, not bytes
  u32 stride_bytes;   // 8
  u32 generation;     // 12
  u32 truncated;      // 16  u32 not u8: keeps the struct 4-aligned and DataView-simple
};

// ── layout pins ────────────────────────────────────────────────────────────
// Every one of these has a matching constant in abi.ts. If you change a field,
// this build breaks first — which is the entire point.

static_assert(sizeof(Fact) == 32, "wire::Fact size is mirrored in abi.ts");
static_assert(alignof(Fact) == 8, "wire::Fact alignment is mirrored in abi.ts");
static_assert(offsetof(Fact, vbits) == 0);
static_assert(offsetof(Fact, entity) == 8);
static_assert(offsetof(Fact, attr) == 12);
static_assert(offsetof(Fact, valid_from) == 16);
static_assert(offsetof(Fact, valid_to) == 20);
static_assert(offsetof(Fact, source) == 24);
static_assert(offsetof(Fact, vkind) == 26);

static_assert(sizeof(Point) == 16, "wire::Point size is mirrored in abi.ts");
static_assert(offsetof(Point, lat) == 0);
static_assert(offsetof(Point, lon) == 4);
static_assert(offsetof(Point, scalar) == 8);
static_assert(offsetof(Point, fact_id) == 12);

static_assert(sizeof(BufferRef) == 20, "wire::BufferRef size is mirrored in abi.ts");

// Trivially copyable is what makes the memcpy-style reinterpretation of the
// staging buffer defined rather than merely working today.
static_assert(std::is_trivially_copyable_v<Fact>);
static_assert(std::is_trivially_copyable_v<Point>);

}  // namespace px::wire
