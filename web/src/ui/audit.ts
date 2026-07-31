// ── web/src/ui/audit.ts ─────────────────────────────────────────────────────
// The audit trail.
//
// Read back OUT of the bitemporal store rather than from a side list, so what
// is shown is what was actually recorded. A panel fed from a parallel array
// could drift from the store, and an audit trail that might differ from the
// record is not an audit trail.
//
// Both allowed and refused queries appear. An access log listing only the
// times access was BLOCKED cannot answer the question an audit exists for —
// what did this system actually show, and to whom.
// ────────────────────────────────────────────────────────────────────────────

export interface AuditEntry {
  query: string
  purpose: string
  rule: string
  allowed: boolean
  rows: number
  when: number
}

export interface AuditLog {
  entries: AuditEntry[]
}

function escapeHtml(s: string): string {
  // Audit entries contain user-typed query text. Interpolating that into
  // innerHTML without escaping would make the audit panel itself an injection
  // sink — a log of what people asked, executing what they asked.
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function timeOf(unix: number): string {
  if (!Number.isFinite(unix) || unix <= 0) return '—'
  return new Date(unix * 1000).toISOString().slice(11, 19) + 'Z'
}

export function renderAudit(host: HTMLElement, log: AuditLog | null): void {
  if (!log || log.entries.length === 0) {
    host.innerHTML = ''
    return
  }

  const denied = log.entries.filter((e) => !e.allowed).length

  const rows = log.entries
    .map(
      (e) => `
      <div class="au-row ${e.allowed ? '' : 'denied'}">
        <span class="au-time num">${timeOf(e.when)}</span>
        <span class="au-query">${escapeHtml(e.query)}</span>
        <span class="au-verdict">${e.allowed ? `${e.rows.toLocaleString()} rows` : 'refused'}</span>
      </div>
      ${e.allowed ? '' : `<div class="au-rule">${escapeHtml(e.rule)} · purpose: ${escapeHtml(e.purpose)}</div>`}`,
    )
    .join('')

  host.innerHTML = `
    <div class="au-head">
      <span class="hud-label">audit trail</span>
      <span class="au-count hud-label">${log.entries.length} recorded${denied ? ` · ${denied} refused` : ''}</span>
    </div>
    <div class="au-note hud-label">stored as facts in the bitemporal store</div>
    ${rows}`
}
