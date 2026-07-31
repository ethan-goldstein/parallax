// ── web/src/ui/queryBuilder/compile.test.ts ─────────────────────────────────
// The builder writes the query language. If it writes something the parser will
// not accept, the interface has told the visitor a lie about what it just did —
// so these assert the exact text, not merely that something was produced.
//
// The engine's own grammar lives in px/ql/parser.hpp; the shapes asserted here
// are taken from the two worked examples in its header comment.
// ────────────────────────────────────────────────────────────────────────────
import { describe, expect, it } from 'vitest'

import type { FilterField } from '../../sources/spec'
import { compile, formatNumber, hasAsOf, quote, type QuerySpec } from './compile'

const magnitude: FilterField = {
  attr: 'magnitude',
  label: 'magnitude',
  kind: 'number',
  unit: 'M',
  min: 0,
  max: 9,
  step: 0.1,
}

const depth: FilterField = { attr: 'depth', label: 'depth', kind: 'number', step: 5 }
const place: FilterField = { attr: 'label', label: 'place', kind: 'text', ops: ['~'] }
const level: FilterField = {
  attr: 'alert_level',
  label: 'alert level',
  kind: 'enum',
  options: [{ value: '2', label: 'red' }],
}

const base: QuerySpec = { source: 'earthquakes', filters: [] }

describe('compile', () => {
  it('emits a bare source when nothing else is set', () => {
    expect(compile(base).text).toBe('earthquakes')
  })

  it('emits a single filter', () => {
    expect(
      compile({ ...base, filters: [{ field: magnitude, op: '>', value: '4.5' }] }).text,
    ).toBe('earthquakes where magnitude > 4.5')
  })

  it('joins several filters with and', () => {
    expect(
      compile({
        ...base,
        filters: [
          { field: magnitude, op: '>=', value: '5' },
          { field: depth, op: '<', value: '70' },
        ],
      }).text,
    ).toBe('earthquakes where magnitude >= 5 and depth < 70')
  })

  it('quotes text values and leaves enum levels bare', () => {
    expect(compile({ ...base, filters: [{ field: place, op: '~', value: 'Alaska' }] }).text).toBe(
      'earthquakes where label ~ "Alaska"',
    )
    expect(
      compile({ source: 'alerts', filters: [{ field: level, op: '=', value: '2' }] }).text,
    ).toBe('alerts where alert_level = 2')
  })

  it('emits every clause in the order the grammar accepts them', () => {
    // where · within · since · order by · limit — the sequence in parser.hpp.
    // A clause emitted out of order parses as an error nobody typed.
    expect(
      compile({
        source: 'vessels',
        filters: [{ field: magnitude, op: '>', value: '1' }],
        spatial: { kind: 'near', lat: 60.15, lon: 24.95, radiusKm: 40 },
        since: '-6h',
        order: { field: 'magnitude', desc: true },
        limit: 100,
      }).text,
    ).toBe(
      'vessels where magnitude > 1 within 40km of (60.15, 24.95) since -6h ' +
        'order by magnitude desc limit 100',
    )
  })

  it('emits a bounding box', () => {
    expect(
      compile({
        ...base,
        spatial: { kind: 'bbox', minLat: -10, minLon: 20, maxLat: 10, maxLon: 40 },
      }).text,
    ).toBe('earthquakes in bbox (-10, 20, 10, 40)')
  })

  it('omits desc when ascending, and omits limit when null', () => {
    expect(compile({ ...base, order: { field: 'depth', desc: false }, limit: null }).text).toBe(
      'earthquakes order by depth',
    )
  })

  it('never emits a float with binary-representation noise', () => {
    // A range input with step 0.1 really does report this value.
    const text = compile({
      ...base,
      filters: [{ field: magnitude, op: '>', value: String(4.2 + 0.1) }],
    }).text
    expect(text).toBe('earthquakes where magnitude > 4.3')
    expect(text).not.toContain('0000')
  })

  it('tags every token with a role, and the roles reconstruct the text', () => {
    const { text, tokens } = compile({
      ...base,
      filters: [{ field: magnitude, op: '>', value: '4.5' }],
    })
    expect(tokens.map((t) => t.role)).toEqual([
      'source',
      'keyword',
      'field',
      'op',
      'literal',
    ])
    // The display colours these tokens; if they did not rejoin to the executed
    // text, the interface would be showing something other than what it ran.
    expect(tokens.map((t) => t.text).join(' ')).toBe(text)
  })
})

describe('formatNumber', () => {
  it('respects the control step and trims trailing zeros', () => {
    expect(formatNumber(4.5, 0.1)).toBe('4.5')
    expect(formatNumber(5, 0.1)).toBe('5')
    expect(formatNumber(30000, 500)).toBe('30000')
    expect(formatNumber(60.150001, 0.0001)).toBe('60.15')
  })
})

describe('quote', () => {
  it('escapes embedded quotes and backslashes', () => {
    expect(quote('Alaska')).toBe('"Alaska"')
    expect(quote('say "hi"')).toBe('"say \\"hi\\""')
    expect(quote('back\\slash')).toBe('"back\\\\slash"')
  })
})

describe('hasAsOf', () => {
  it('detects a real as-of clause', () => {
    expect(hasAsOf('earthquakes as of "2026-03-01T00:00:00"')).toBe(true)
    expect(hasAsOf('earthquakes AS  OF -30d')).toBe(true)
  })

  it('ignores the words inside a string literal', () => {
    // Otherwise a place name would make the scrubber stop driving the query.
    expect(hasAsOf('earthquakes where label ~ "as of yet unnamed"')).toBe(false)
  })

  it('is false for an ordinary query', () => {
    expect(hasAsOf('vessels within 40km of (60.15, 24.95)')).toBe(false)
  })
})
