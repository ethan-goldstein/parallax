// ── web/src/ui/explain.ts ───────────────────────────────────────────────────
// The EXPLAIN viewer.
//
// Query engines are invisible. Making one visible is the entire point of this
// panel: it shows which access path the planner chose, which it rejected and
// at what cost, what it predicted, and what actually happened.
//
// The most informative thing on screen is the estimated-vs-actual column,
// because two of the four estimators are EXACT (the sorted Morton index and
// the monotone system-time column can be counted, not guessed) while scalar
// selectivity is a flat 1/3 guess with no histograms behind it. So spatial
// rows routinely show est == actual and predicate rows are visibly wrong —
// and that contrast is the honest picture of what the planner knows.
// ────────────────────────────────────────────────────────────────────────────

export interface ExplainNode {
  op: string
  index: string
  detail: string
  reason: string
  estRows: number
  estCost: number
  actualRows: number
  actualUs: number
  chunksTotal: number
  chunksSkipped: number
  geoRanges: number
  geoCandidates: number
  rowsExamined: number
  exact: boolean
  children: ExplainNode[]
}

export interface ExplainPlan {
  planUs: number
  validAt: number
  sysAt: number
  emittedRows: number
  rejected: { op: string; estCost: number; why: string }[]
  root: ExplainNode | null
  error?: string
}

function flatten(node: ExplainNode | null, depth = 0): { node: ExplainNode; depth: number }[] {
  if (!node) return []
  // Children first: the scan is the deepest node but executes first, and a
  // plan tree that reads top-down in execution order is far easier to follow
  // than one that reads root-first.
  const below = node.children.flatMap((c) => flatten(c, depth + 1))
  return [...below, { node, depth }]
}

function fmtRows(n: number): string {
  return Math.round(n).toLocaleString()
}

function fmtUs(us: number): string {
  if (us >= 1000) return `${(us / 1000).toFixed(2)} ms`
  // "us", not "µs". These labels sit inside elements with
  // text-transform: uppercase, and CSS uppercases µ (U+00B5 MICRO SIGN) to Μ
  // (U+039C GREEK CAPITAL MU) — so "0.8 µs" renders as "0.8 MS" and reads as
  // milliseconds. A unit that is wrong by 1000x on a performance panel is
  // worse than no panel.
  return `${us.toFixed(1)} us`
}

/**
 * Ratio between prediction and reality, as a readable factor.
 *
 * Reported in both directions — over- and under-estimates are different
 * failures. Overestimating wastes a cheaper plan; underestimating picks one
 * that blows up.
 */
function misestimate(est: number, actual: number): { label: string; bad: boolean } {
  if (actual === 0 && est === 0) return { label: 'exact', bad: false }
  if (actual === 0) return { label: `${fmtRows(est)}× over`, bad: est > 10 }
  const ratio = est / actual
  if (ratio >= 0.95 && ratio <= 1.05) return { label: 'exact', bad: false }
  if (ratio > 1) return { label: `${ratio.toFixed(1)}× over`, bad: ratio >= 10 }
  return { label: `${(1 / ratio).toFixed(1)}× under`, bad: 1 / ratio >= 10 }
}

export function renderExplain(host: HTMLElement, plan: ExplainPlan | null): void {
  if (!plan) {
    host.innerHTML = ''
    return
  }
  if (plan.error) {
    host.innerHTML = `<div class="explain-error">${plan.error}</div>`
    return
  }

  const rows = flatten(plan.root)
  const maxUs = Math.max(...rows.map((r) => r.node.actualUs), 0.001)

  const body = rows
    .map(({ node, depth }) => {
      const m = misestimate(node.estRows, node.actualRows)
      const share = (node.actualUs / maxUs) * 100

      const notes: string[] = []
      if (node.chunksTotal > 0) {
        notes.push(`${node.chunksSkipped}/${node.chunksTotal} chunks skipped`)
      }
      if (node.geoRanges > 0) {
        // The reason line already states the range count, so only the measured
        // false-positive rate is added here.
        if (node.geoCandidates > 0) {
          // Z-order over-covers a box; this is how much, measured. Publishing
          // it is more useful than claiming the index is good.
          const fp = node.geoCandidates - node.actualRows
          notes.push(`${fp} false positive${fp === 1 ? '' : 's'}`)
        }
      }
      if (node.rowsExamined > 0) notes.push(`${fmtRows(node.rowsExamined)} examined`)

      return `
      <div class="ex-row" style="--depth:${depth}">
        <div class="ex-op">
          <span class="ex-name">${node.op}</span>
          ${node.index !== 'none' ? `<span class="ex-index">${node.index}</span>` : ''}
          ${node.detail ? `<span class="ex-detail">${node.detail}</span>` : ''}
        </div>
        <div class="ex-est num">${fmtRows(node.estRows)}${node.exact ? '' : '≈'}</div>
        <div class="ex-actual num">${fmtRows(node.actualRows)}</div>
        <div class="ex-ratio ${m.bad ? 'bad' : ''}">${m.label}</div>
        <div class="ex-time num">${fmtUs(node.actualUs)}</div>
        <div class="ex-bar"><span style="width:${share.toFixed(1)}%"></span></div>
        ${node.reason || notes.length ? `<div class="ex-note">${[node.reason, ...notes].filter(Boolean).join(' · ')}</div>` : ''}
      </div>`
    })
    .join('')

  const rejected = plan.rejected.length
    ? `<div class="ex-rejected">
         <span class="hud-label">considered</span>
         ${plan.rejected.map((r) => `<span class="ex-rej">${r.op} <em>${Math.round(r.estCost).toLocaleString()}</em></span>`).join('')}
       </div>`
    : ''

  host.innerHTML = `
    <div class="ex-head">
      <span class="hud-label">plan</span>
      <span class="ex-cols hud-label"><span>est</span><span>actual</span><span>ratio</span><span>time</span></span>
    </div>
    ${body}
    ${rejected}
    <div class="ex-foot hud-label">planned in ${fmtUs(plan.planUs)} · returned ${fmtRows(plan.emittedRows)} rows</div>`
}
