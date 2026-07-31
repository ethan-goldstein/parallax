# 0004. Policy is enforced at plan time, not on output rows

**Status:** accepted, Phase 7

## Context

Access control on an analytical engine is almost always applied to results: run the query, then
filter or redact what the caller is not allowed to see. It is simple, and it is what most systems
do.

The threat this engine cares about is different. A spatial index answers "show me traffic density
in this district" and "show me where this one person went" with the *same code path at the same
cost*. Every capability here is dual-use. Filtering the output does not help, because the harm is
the query being answerable at all, and a determined caller can reconstruct an identity from a
sequence of individually permitted results.

## Decision

The policy engine evaluates against the **query plan**, after cardinality is estimated but before
a single row is read. Rule R1 refuses a query whose plan estimates fewer than `k` distinct
entities on an attribute typed Precise or above. A denial is a first-class result carrying a rule
id, a plain-language explanation, and a remedy.

## Why

Refusing before execution is the only point where the refusal is total. Nothing is read, so
nothing can leak through timing, partial results, or an error message that differs by whether
rows existed.

**The reason this is sound rather than a guess** is a property of this engine specifically: two
of the four cardinality estimators are exact, not approximate. The system-time estimator is exact
because `sys_from` is monotone (decision 0001), and the spatial estimator is exact because a
Z-order range is a contiguous sorted slice (decision 0003). A plan-time refusal built on an
approximate estimate would be unsound in the dangerous direction, permitting an identifying query
because the estimate came in high. Here, for those two predicates, it cannot.

## Consequences

- `k=5` is a judgement call, not a standard. Real k-anonymity work derives k from the data and the
  threat model. Stated in the README rather than hidden.
- Unregistered attributes default to `Public`, which is fail-open. Defensible only because this
  project collects nothing person-linked; in a system that did, the default must invert. Also
  stated in the README.
- The audit log is written into the bitemporal store as ordinary facts, so the record of what was
  refused time-travels under the same scrubber as everything else. The system is auditable by its
  own machinery rather than by a side channel.
