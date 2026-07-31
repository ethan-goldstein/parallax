// ── web/src/ui/inspector.ts ─────────────────────────────────────────────────
// What a point on the map actually is.
//
// Until this existed the globe was six thousand coloured dots and no way to ask
// any of them a question. The legend says what the colour encodes; it cannot say
// that this dot is a magnitude 5.2 forty-six kilometres east of Petropavlovsk,
// that USGS said so, that the record is US public domain, and when we learned
// it. That gap is the difference between a picture and reconnaissance.
//
// Everything here is rendered from the engine's own JSON. Symbols are resolved
// to text on the C++ side — the symbol table deliberately does not cross the
// boundary — so this file never has to know what a SymbolId is.
// ────────────────────────────────────────────────────────────────────────────
import { SOURCE_BY_ID } from '../sources/registry'

/** One fact, exactly as `Session::inspect_json` emits it. */
export interface InspectFact {
  attr: string
  kind: number
  value: number | string | boolean | null | { lat: number; lon: number }
  source: number
  validFrom: number
  validTo: number
  sysFrom: number
  sysTo: number
}

export interface InspectHit {
  hit: true
  factId: number
  entity: number
  lat: number
  lon: number
  distanceM: number
  attr: string
  source: number
  /** True at the caller's point on both axes. */
  attributes: InspectFact[]
  /** Everything ever said about this entity, in assignment order. */
  history: InspectFact[]
}

export type InspectResult = InspectHit | { hit: false }

/**
 * `SourceId` is stored as a u16 and the audit trail writes 0xFFFF as a sentinel
 * for "not a feed". Indexing SOURCE_BY_ID with that would attribute an audit
 * record to whichever source happens to sort last.
 */
const NOT_A_FEED = 0xffff

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )
}

function sourceName(id: number): string {
  if (id === NOT_A_FEED) return 'engine'
  return SOURCE_BY_ID[id]?.name ?? `source ${id}`
}

function sourceShort(id: number): string {
  if (id === NOT_A_FEED) return 'engine'
  return SOURCE_BY_ID[id]?.key ?? String(id)
}

function utc(unixSeconds: number): string {
  // Open-ended intervals carry the i32 sentinel; printing it as a date would
  // claim the fact stops being true in 2038.
  if (unixSeconds >= 2_147_483_000) return 'open'
  return new Date(unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z'
}

function formatValue(f: InspectFact): string {
  const v = f.value
  if (v === null) return '—'
  if (typeof v === 'object') return `${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}`
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2)
  return String(v)
}

/** Attribute names are engine identifiers; this is what a person calls them. */
function readable(attr: string): string {
  return attr.replace(/_/g, ' ')
}

/**
 * The label attribute, whichever source named it.
 *
 * Every source picks its own name — `label`, `region`, `alert_label` — because
 * the attribute namespace is shared and two sources writing different things to
 * one name would collide in the store.
 */
function titleOf(hit: InspectHit): string | null {
  const label = hit.attributes.find((f) => f.attr.endsWith('label') || f.attr === 'region')
  if (!label) return null
  const v = label.value
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Attributes with more than one version in history.
 *
 * This is the whole reason the engine ships history separately from the current
 * state: two rows for one attribute means somebody changed their mind, and the
 * pair is the operational picture before and after.
 *
 * It will usually be empty today, and that is honest rather than broken — see
 * the note in the panel footer.
 */
function revisions(hit: InspectHit): Map<string, InspectFact[]> {
  const byAttr = new Map<string, InspectFact[]>()
  for (const f of hit.history) {
    const list = byAttr.get(f.attr)
    if (list) list.push(f)
    else byAttr.set(f.attr, [f])
  }
  for (const [attr, list] of byAttr) {
    if (list.length < 2) byAttr.delete(attr)
  }
  return byAttr
}

export function renderInspector(host: HTMLElement, data: InspectResult | null): void {
  if (!data || !data.hit) {
    // Empty rather than a placeholder: `.panel:empty` collapses it, so the rail
    // does not carry a permanently blank box.
    host.innerHTML = ''
    return
  }

  const title = titleOf(data)
  const rows = data.attributes
    // The label is the heading; repeating it as a row is noise.
    .filter((f) => !(f.attr.endsWith('label') || f.attr === 'region'))
    .map(
      (f) => `<div class="in-row">
          <span class="hud-label">${escapeHtml(readable(f.attr))}</span>
          <span class="v">${escapeHtml(formatValue(f))}</span>
          <span class="in-src">${escapeHtml(sourceShort(f.source))}</span>
        </div>`,
    )
    .join('')

  const rev = revisions(data)
  const revBlock =
    rev.size === 0
      ? ''
      : `<div class="in-section hud-label">revisions</div>` +
        [...rev]
          .map(
            ([attr, list]) => `<div class="in-rev">
              <span class="hud-label">${escapeHtml(readable(attr))}</span>
              <span class="v">${list.map((f) => escapeHtml(formatValue(f))).join(' → ')}</span>
              <span class="in-src sys">txn ${list.map((f) => f.sysFrom).join(' → ')}</span>
            </div>`,
          )
          .join('')

  // The picked fact's own intervals. Teal is valid time and violet is system
  // time, everywhere in this project without exception.
  const picked = data.attributes.find((f) => f.attr === data.attr) ?? data.attributes[0]
  const timeBlock = picked
    ? `<div class="in-row">
         <span class="hud-label">valid from</span>
         <span class="v ok">${escapeHtml(utc(picked.validFrom))}</span>
         <span class="in-src"></span>
       </div>
       <div class="in-row">
         <span class="hud-label">known at</span>
         <span class="v sys">txn ${picked.sysFrom}</span>
         <span class="in-src"></span>
       </div>`
    : ''

  const meta = SOURCE_BY_ID[data.source]
  const licence = meta
    ? `<div class="in-licence">${escapeHtml(meta.license)}${
        meta.nonCommercial ? ' · non-commercial' : ''
      }${meta.shareAlike ? ' · share-alike' : ''}</div>`
    : ''

  host.innerHTML = `
    <div class="in-head">
      <span class="hud-label">inspect</span>
      <span class="in-dist">${Math.round(data.distanceM).toLocaleString()} m</span>
    </div>
    <div class="in-title">${escapeHtml(title ?? `entity ${data.entity}`)}</div>
    <div class="in-coord">${data.lat.toFixed(4)}, ${data.lon.toFixed(4)}</div>
    ${rows}
    ${timeBlock}
    ${revBlock}
    <div class="in-source">${escapeHtml(sourceName(data.source))}</div>
    ${licence}
  `
}

/**
 * The hover tooltip.
 *
 * Deliberately thin: a name and one number. Anything more competes with the map
 * for attention at exactly the moment the user is still deciding what to look
 * at, and the full answer is one click away.
 */
export function renderTooltip(
  host: HTMLElement,
  data: InspectResult | null,
  screen: { x: number; y: number } | null,
): void {
  if (!data || !data.hit || !screen) {
    host.hidden = true
    return
  }

  const title = titleOf(data)
  const primary = data.attributes.find(
    (f) => !(f.attr.endsWith('label') || f.attr === 'region') && f.attr !== data.attr,
  )

  host.innerHTML =
    `<span class="tt-title">${escapeHtml(title ?? `entity ${data.entity}`)}</span>` +
    (primary
      ? `<span class="tt-value">${escapeHtml(readable(primary.attr))} ${escapeHtml(
          formatValue(primary),
        )}</span>`
      : '')

  // Flip before the edge rather than after, so the tooltip never induces a
  // horizontal scrollbar on the body.
  const flipX = screen.x > window.innerWidth - 260
  host.style.left = `${flipX ? screen.x - 16 : screen.x + 16}px`
  host.style.top = `${screen.y + 16}px`
  host.style.transform = flipX ? 'translateX(-100%)' : ''
  host.hidden = false
}
