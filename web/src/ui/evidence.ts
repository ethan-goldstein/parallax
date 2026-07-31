// ── web/src/ui/evidence.ts ──────────────────────────────────────────────────
// The merge-evidence panel.
//
// This is the deliverable of entity resolution, not a debug view. A merge an
// analyst cannot inspect is a merge they cannot defend, and in an intelligence
// system an unexplainable merge is worse than no merge at all — it silently
// asserts that two things are one thing, and everything downstream inherits
// that assertion.
//
// So every accepted pair renders its full derivation: each field, the values
// from both sides, and the signed log-odds contribution as a bar. The
// contributions sum to the score, which the engine asserts in tests — the
// panel is showing the actual arithmetic, not a summary of it.
// ────────────────────────────────────────────────────────────────────────────

export interface EvidenceRow {
  field: string
  a: string
  b: string
  contribution: number
  agreed: boolean
}

export interface MergeRow {
  pairIndex: number
  a: number
  b: number
  score: number
  evidence: EvidenceRow[]
}

export interface MergeEvidence {
  stats: {
    records: number
    pairsCompared: number
    pairsAccepted: number
    clusters: number
    mergedRecords: number
    blocks: number
    blocksSkipped: number
    elapsedMs: number
  }
  merges: MergeRow[]
}

function bar(contribution: number, maxAbs: number): string {
  // Signed, centred bar: support extends right, opposition left. A single
  // unsigned magnitude would hide which way a field voted, which is exactly
  // the thing being explained.
  const pct = Math.min(Math.abs(contribution) / maxAbs, 1) * 50
  const positive = contribution >= 0
  return `<span class="ev-bar">
    <span class="ev-bar-fill ${positive ? 'pos' : 'neg'}"
          style="${positive ? 'left:50%' : `right:50%`};width:${pct.toFixed(1)}%"></span>
  </span>`
}

/**
 * Stats come from the evidence JSON only.
 *
 * The engine also returns them from resolveEntities(), and taking them from
 * both would let two copies of the same numbers drift apart — the panel would
 * then report a merge count from one call and a cluster count from another.
 * One source, one moment.
 */
export function renderEvidence(host: HTMLElement, data: MergeEvidence | null): void {
  if (!data) {
    host.innerHTML = ''
    return
  }

  const s = data.stats

  // A resolution that merged nothing is a legitimate outcome and must say so
  // rather than rendering an empty box that looks broken.
  const head = `
    <div class="ev-head">
      <span class="hud-label">entity resolution</span>
      <span class="ev-headline num">${s.mergedRecords.toLocaleString()} of ${s.records.toLocaleString()} merged</span>
    </div>
    <div class="ev-stats">
      <span>${s.pairsCompared.toLocaleString()} pairs compared</span>
      <span>${s.pairsAccepted.toLocaleString()} accepted</span>
      <span>${s.clusters.toLocaleString()} entities</span>
      <span>${s.elapsedMs.toFixed(1)} ms</span>
      ${s.blocksSkipped > 0 ? `<span class="warn">${s.blocksSkipped} oversized blocks skipped</span>` : ''}
    </div>`

  if (data.merges.length === 0) {
    host.innerHTML =
      head +
      `<div class="ev-empty">No cross-agency duplicates cleared the threshold in this window.
        USGS and EMSC coverage overlap mainly around the Mediterranean —
        a window with no shared events legitimately merges nothing.</div>`
    return
  }

  const body = data.merges
    .map((m) => {
      const maxAbs = Math.max(...m.evidence.map((e) => Math.abs(e.contribution)), 1)
      const rows = m.evidence
        .map(
          (e) => `
        <div class="ev-row ${e.agreed ? 'agree' : 'disagree'}">
          <span class="ev-field">${e.field}</span>
          <span class="ev-vals">${e.a}${e.b ? ` <em>vs</em> ${e.b}` : ''}</span>
          ${bar(e.contribution, maxAbs)}
          <span class="ev-contrib num">${e.contribution >= 0 ? '+' : ''}${e.contribution.toFixed(2)}</span>
        </div>`,
        )
        .join('')

      return `
      <details class="ev-merge">
        <summary>
          <span class="ev-pair">#${m.a} <em>+</em> #${m.b}</span>
          <span class="ev-score num">${m.score.toFixed(2)}</span>
        </summary>
        ${rows}
        <div class="ev-total">
          <span class="hud-label">sum</span>
          <span class="num">${m.score.toFixed(2)}</span>
        </div>
      </details>`
    })
    .join('')

  host.innerHTML = `${head}<div class="ev-list">${body}</div>`
}
