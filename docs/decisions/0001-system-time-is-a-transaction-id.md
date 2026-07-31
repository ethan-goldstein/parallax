# 0001. System time is a transaction id, not a timestamp

**Status:** accepted, Phase 2

## Context

A bitemporal store has two time axes. Valid time is when a fact was true in the world. System
time is when the store came to believe it. Valid time is domain data and obviously belongs to
the caller. System time is the store's own bookkeeping, and the obvious implementation is a
wall-clock timestamp taken at insert.

## Decision

`sys_from` and `sys_to` are monotonically increasing 64-bit transaction ids, not timestamps.
Wall-clock time is recorded separately as an ordinary attribute when a caller wants it.

## Why

A wall clock is not monotone. NTP adjusts it, daylight saving shifts it, a VM migrates and it
jumps. Any of those can produce two facts whose stored system times order them the opposite way
round from the order they were actually written. In a store whose entire purpose is answering
"what did we believe first," that is not a rounding error, it is a wrong answer with no
symptom.

A transaction id is monotone by construction. It also makes the visibility predicate cheap:
`sys_from <= S < sys_to` is an integer comparison on a column that is already sorted, which is
what lets the cardinality estimator for a system-time filter be **exact** rather than
approximate. That exactness is load-bearing later, in decision 0004.

## Consequences

- "As of 3pm yesterday" is not directly expressible. The caller resolves a wall-clock instant to
  a transaction id first, via a lookup that is itself a bitemporal query.
- Transaction ids are meaningless across store instances, so a snapshot cannot be merged with a
  differently-originated one without remapping.
- Accepted both. The alternative trades a correctness property for an ergonomic one.
