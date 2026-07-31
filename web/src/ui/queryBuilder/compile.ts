// ── web/src/ui/queryBuilder/compile.ts ──────────────────────────────────────
// Builder state → query text. Pure: no DOM, no engine, no clock.
//
// The point of the builder is not to hide the query language. It is to write it
// in front of you. A visitor who has never seen this grammar drags a slider,
// watches `where magnitude > 4.5` appear, and has learned the language — which
// is a better outcome than either a bare text box they cannot use or a set of
// controls that quietly produce something they never see.
//
// So this file has one job and it is the honest one: produce EXACTLY the text
// that will be executed, plus the role of each token so the display can colour
// it. Roles are emitted as the string is built rather than by re-lexing the
// result, because re-lexing would be a second, worse parser that could disagree
// with the first about what it just wrote.
//
// ── clause order is load-bearing ────────────────────────────────────────────
//
// px/ql/parser.hpp accepts pipe operators in a fixed sequence. Building the
// string from a single ordered array of emitters, rather than concatenating at
// six call sites, is what stops a later edit from emitting `limit` before
// `order by` and producing a parse error nobody typed.
// ────────────────────────────────────────────────────────────────────────────
import type { CmpOp, FilterField } from '../../sources/spec'

export type TokenRole = 'source' | 'keyword' | 'field' | 'literal' | 'op'

export interface Token {
  text: string
  role: TokenRole
}

export interface FilterClause {
  field: FilterField
  op: CmpOp
  /** Raw value. Numbers are formatted to the field's step; text is quoted. */
  value: string
}

export interface SpatialNear {
  kind: 'near'
  lat: number
  lon: number
  radiusKm: number
}

export interface SpatialBox {
  kind: 'bbox'
  minLat: number
  minLon: number
  maxLat: number
  maxLon: number
}

export interface QuerySpec {
  /** A registered qlName. The builder can only offer these, so it cannot miss. */
  source: string
  filters: readonly FilterClause[]
  spatial?: SpatialNear | SpatialBox | null
  /** Relative window, e.g. `-24h`. Null means no `since`. */
  since?: string | null
  order?: { field: string; desc: boolean } | null
  limit?: number | null
}

/** Decimal places implied by a step, so `0.1` never emits `4.300000000000001`. */
function decimalsFor(step: number | undefined): number {
  if (!step || !Number.isFinite(step)) return 2
  const s = String(step)
  const dot = s.indexOf('.')
  return dot === -1 ? 0 : s.length - dot - 1
}

/**
 * A numeric literal the lexer will accept.
 *
 * Rounded to the control's own precision rather than printed raw: a range input
 * reports `4.300000000000001` for a step of 0.1, and that reaches the lexer as a
 * number with fifteen significant figures — legal, but it looks like a bug in
 * the box that claims to show you what it wrote.
 */
export function formatNumber(value: number, step?: number): string {
  const fixed = value.toFixed(decimalsFor(step))
  // Trim a trailing `.0` so an integer reads as an integer.
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed
}

/** Quotes a string literal, escaping any embedded quote. */
export function quote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function literalFor(clause: FilterClause): string {
  if (clause.field.kind === 'number') {
    const n = Number(clause.value)
    return Number.isFinite(n) ? formatNumber(n, clause.field.step) : '0'
  }
  // An enum's values are numeric levels in every layer that has one, so they are
  // emitted bare; anything non-numeric is quoted.
  if (clause.field.kind === 'enum' && Number.isFinite(Number(clause.value))) {
    return clause.value
  }
  return quote(clause.value)
}

/**
 * Emits the clauses in grammar order.
 *
 * Each entry appends to `out`. Adding a clause means adding one entry HERE, in
 * the right position, rather than finding the right place in a string
 * concatenation — which is the mistake this shape exists to prevent.
 */
const EMITTERS: readonly ((spec: QuerySpec, out: Token[]) => void)[] = [
  // source
  (spec, out) => out.push({ text: spec.source, role: 'source' }),

  // where <expr> [and <expr>…]
  (spec, out) => {
    if (spec.filters.length === 0) return
    out.push({ text: 'where', role: 'keyword' })
    spec.filters.forEach((c, i) => {
      if (i > 0) out.push({ text: 'and', role: 'keyword' })
      out.push({ text: c.field.attr, role: 'field' })
      out.push({ text: c.op, role: 'op' })
      out.push({ text: literalFor(c), role: 'literal' })
    })
  },

  // within <d>km of (lat, lon)  |  in bbox (…)
  (spec, out) => {
    const s = spec.spatial
    if (!s) return
    if (s.kind === 'near') {
      out.push({ text: 'within', role: 'keyword' })
      out.push({ text: `${formatNumber(s.radiusKm, 1)}km`, role: 'literal' })
      out.push({ text: 'of', role: 'keyword' })
      // Explicit coordinates, never `port:SGSIN`: px/ql/plan.cpp resolves named
      // places through a gazetteer that is not built, so a named place parses
      // and then matches nothing.
      out.push({
        text: `(${formatNumber(s.lat, 0.0001)}, ${formatNumber(s.lon, 0.0001)})`,
        role: 'literal',
      })
    } else {
      out.push({ text: 'in', role: 'keyword' })
      out.push({ text: 'bbox', role: 'keyword' })
      const n = (v: number): string => formatNumber(v, 0.0001)
      out.push({
        text: `(${n(s.minLat)}, ${n(s.minLon)}, ${n(s.maxLat)}, ${n(s.maxLon)})`,
        role: 'literal',
      })
    }
  },

  // since <rel>
  (spec, out) => {
    if (!spec.since) return
    out.push({ text: 'since', role: 'keyword' })
    out.push({ text: spec.since, role: 'literal' })
  },

  // order by <field> [desc]
  (spec, out) => {
    if (!spec.order) return
    out.push({ text: 'order', role: 'keyword' })
    out.push({ text: 'by', role: 'keyword' })
    out.push({ text: spec.order.field, role: 'field' })
    if (spec.order.desc) out.push({ text: 'desc', role: 'keyword' })
  },

  // limit <n>
  (spec, out) => {
    if (spec.limit === null || spec.limit === undefined) return
    out.push({ text: 'limit', role: 'keyword' })
    out.push({ text: String(Math.max(1, Math.round(spec.limit))), role: 'literal' })
  },
]

export function compile(spec: QuerySpec): { text: string; tokens: Token[] } {
  const tokens: Token[] = []
  for (const emit of EMITTERS) emit(spec, tokens)
  return { text: tokens.map((t) => t.text).join(' '), tokens }
}

/**
 * Whether a query pins its own temporal axes.
 *
 * When it does, the scrubber stops driving it — the query said where in time it
 * wants to be and overriding that would make the language a liar. Quoted strings
 * are blanked first so a place name containing the words cannot trigger it.
 */
export function hasAsOf(sql: string): boolean {
  return /\bas\s+of\b/i.test(sql.replace(/"(?:[^"\\]|\\.)*"/g, '""'))
}
