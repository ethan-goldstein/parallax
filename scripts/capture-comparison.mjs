// ── scripts/capture-comparison.mjs ──────────────────────────────────────────
// Regenerates docs/images/system-time-comparison.png — the README figure.
//
// The figure makes a claim that would be easy to fake in an image editor: that
// two frames of the same map, at the same valid time, differ only because of
// where they sit on the SYSTEM axis. So the figure is generated rather than
// composed, against the deployed site, with the numbers read out of the running
// store. Anyone can re-run this and get the same shape of answer.
//
//   npm i -D playwright && npx playwright install chromium
//   node scripts/capture-comparison.mjs docs/images
//
// Playwright is deliberately NOT a dependency of this repo: it is a 150 MB
// browser download needed by one script that runs perhaps twice a year, and
// making every clone pay for it to build a PNG would be a poor trade.
// ────────────────────────────────────────────────────────────────────────────
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const URL = process.env.PX_URL ?? 'https://ethan-goldstein.github.io/parallax/'
const OUT = process.argv[2] ?? '.'

/** Transaction to rewind to, as a fraction of the newest one. */
const EARLIER = 0.3
/** Poll cycles to sit through, so the system axis has a range worth rewinding. */
const ACCUMULATE_MS = 60_000

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.5 })

// Playwright's own screenshot waits on `document.fonts.ready`, and on this page
// that promise never settles — it times out rather than capturing. CDP does no
// such wait, and by this point the glyphs have long since painted.
const cdp = await page.context().newCDPSession(page)

// The guided tour auto-starts for a first-time visitor and drives the very axes
// this script sets. Without this the capture comes back with a tour caption
// across the map and the scrubber wherever the tour left it.
await page.addInitScript(() => {
  try { localStorage.setItem('parallax.tourSeen', '1') } catch { /* private mode */ }
})

await page.goto(URL, { waitUntil: 'domcontentloaded' })

// Waited for rather than slept through: the feeds settle at different times and
// a fixed timer would capture whatever happened to have arrived by then.
await page.waitForFunction(
  () => document.querySelector('#status')?.textContent?.trim() === 'LIVE',
  null,
  { timeout: 120_000 },
)
await page.waitForTimeout(ACCUMULATE_MS)

await page.evaluate(() => {
  const px = window.__parallax
  document.querySelector('#dock').hidden = true
  px.globe.flyTo(34, 14, 2.05)
})
await page.waitForTimeout(6000)

/** Pins both axes, waits for the render, then captures. `sysAt` null = newest. */
async function shoot(name, sysAt) {
  await page.evaluate((s) => {
    const px = window.__parallax
    // Valid time is pinned to the present in BOTH frames. If it drifted, the
    // comparison would quietly become "two different instants", which is the
    // ordinary thing every dashboard already does and proves nothing.
    px.scrubber.pin({
      validAt: px.scrubber.validMax,
      sysAt: s === null ? Number.MAX_SAFE_INTEGER : s,
    })
    px.app.set({ validAt: px.scrubber.state.validAt, sysAt: px.scrubber.state.sysAt })
  }, sysAt)
  await page.waitForTimeout(3500)

  const read = await page.evaluate(() => {
    const px = window.__parallax
    return {
      visible: Object.values(px.globe.layerCounts).reduce((a, c) => a + c, 0),
      sysAt: px.app.state.sysAt,
    }
  })
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'))
  console.log(name, JSON.stringify(read))
  return read
}

// Newest first, because its sysAt is the ceiling the earlier frame is a
// fraction of.
const after = await shoot('after', null)
const before = await shoot('before', Math.floor(after.sysAt * EARLIER))

await browser.close()

console.log(JSON.stringify({ before, after }, null, 2))
console.log(`
Now compose the two frames. The crop drops the empty tab rail, the brand bar and
the engine footer so the globe and the readout get the pixels instead:

  ffmpeg -y -i ${OUT}/before.png -i ${OUT}/after.png -filter_complex \\
    "[0]crop=1515:778:75:82,pad=iw+14:ih:0:0:color=0x14141aff[l];\\
     [1]crop=1515:778:75:82[r];[l][r]hstack=inputs=2[o]" \\
    -map "[o]" ${OUT}/system-time-comparison.png
`)
