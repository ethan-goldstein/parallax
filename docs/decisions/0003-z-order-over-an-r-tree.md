# 0003. Z-order curve rather than an R-tree

**Status:** accepted, Phase 4a

## Context

Spatial queries need an index. The default answer is an R-tree, and it is the better structure
for most workloads: tighter bounding volumes, better worst-case query performance.

## Decision

A Morton-code Z-order curve over quantised coordinates, kept as a sorted array.

## Why

The store is append-mostly and the query is almost always a bounding box that then feeds into a
bitemporal filter. Under those conditions the Z-order curve gives three things an R-tree does
not:

1. **The index is a sorted integer array.** It serialises into a snapshot with no pointer fixups,
   which matters because the whole engine ships as WASM and gets rehydrated in a browser.
2. **A range on the curve is a contiguous slice**, so the count of candidates in a box is a
   subtraction of two binary searches. That is what makes the spatial cardinality estimator
   cheap enough to run at plan time.
3. **No rebalancing.** An R-tree degrades on append-heavy insertion and wants periodic
   maintenance the engine has no good moment to perform.

## Consequences

- Z-order is worse than an R-tree on long thin diagonal query boxes, because such a box straddles
  many discontiguous curve ranges. Accepted: the workload is dominated by roughly square viewport
  boxes.
- Quantisation fixes the precision floor at index build time.
- The curve's discontinuities near the antimeridian and poles are a real source of bugs. This is
  precisely where the differential test from decision 0002 paid for itself.
