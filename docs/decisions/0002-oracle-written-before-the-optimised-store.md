# 0002. The oracle is written before the store it verifies

**Status:** accepted, Phase 2

## Context

The bitemporal store is the component everything else rests on. Its visibility predicate has
four terms across two independent time axes, which is exactly the shape of logic where an
off-by-one is both easy to write and invisible in a unit test, because the test author and the
implementer share the same misunderstanding.

## Decision

A deliberately naive reference implementation, `std::vector<Fact>` with a linear scan and no
indexes, zone maps, or SIMD, written **before** the optimised store. Then a property test: for
any random sequence of assertions and retractions, and any random `(T, S)`, the fast store's
`as_of(T, S)` must equal the oracle's as a sorted set.

## Why

Unit tests check the cases the author thought of. A differential test against an independent
implementation checks the cases nobody thought of, which is where the bugs are.

The ordering is the part that matters and the part that is easy to skip. An oracle written
after the optimised version tends to be written by reading it, which means it inherits its
assumptions and agrees with it for exactly the wrong reasons. Written first, it cannot.

## Consequences

- Two implementations of the same semantics to maintain. Accepted: the oracle is about 40 lines
  and deliberately dumb, so it changes only when the semantics genuinely change.
- The same pattern was reused for the spatial index (brute-force bbox and k-NN) and for entity
  resolution (transitive closure by relaxation rather than union-find).
- It earned its keep. It caught an antimeridian-crossing bounding box that inverted and silently
  matched nothing, and a bidirectional-BFS stitch that returned a path containing a step that was
  not an edge. Both would have passed any unit test I would have thought to write.
