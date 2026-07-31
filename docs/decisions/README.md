# Decision records

One record per load-bearing decision, written so the tradeoff can be defended out loud rather
than rediscovered from the code. Each says what was decided, what it cost, and what it rules out.

| # | Decision | Phase |
|---|---|---|
| [0001](0001-system-time-is-a-transaction-id.md) | System time is a transaction id, not a timestamp | 2 |
| [0002](0002-oracle-written-before-the-optimised-store.md) | The oracle is written before the store it verifies | 2 |
| [0003](0003-z-order-over-an-r-tree.md) | Z-order curve rather than an R-tree | 4a |
| [0004](0004-policy-refusal-at-plan-time.md) | Policy is enforced at plan time, not on output rows | 7 |
| [0005](0005-maplibre-as-renderer-host.md) | MapLibre hosts the renderer; the zero-copy path stays | 9 |

0001, 0003 and 0004 are a chain: system time is monotone and a Z-order range is contiguous, which
makes two of the four cardinality estimators exact, which is the only reason refusing a query
before reading a row is sound rather than a guess.

0005 is the one reversal in the set. It supersedes the rationale that used to sit in the header of
`web/src/render/globe.ts`, and it is recorded rather than quietly edited because the original
argument was correct about MapLibre's *source* API and wrong about what that cost.
