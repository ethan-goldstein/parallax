// ── web/scripts/fetch-tle.mjs ───────────────────────────────────────────────
// Fetches the four CelesTrak element-set groups into public/tle/ as a
// same-origin snapshot, with a manifest recording when.
//
// ── why a snapshot and not a live fetch ─────────────────────────────────────
//
// The satellite layer used to fetch CelesTrak from every visitor's browser on
// every page load: four requests per load, more on every reload during
// development. CelesTrak asks for no more than one fetch per group every two
// hours and blocks addresses that ignore that, which is presumably how the
// development machine's address ended up unable to reach it at all. Meanwhile
// element sets are re-determined only a few times a day, so a live fetch was
// buying nothing a daily snapshot does not.
//
// Bitemporally nothing changes. The system time of a propagated position is
// the TLE EPOCH, read from the element set itself, not the moment this script
// ran. A snapshot fetched at 03:00 carrying an epoch of 01:00 lands on the
// system axis at 01:00 either way.
//
// ── when it runs ────────────────────────────────────────────────────────────
//
//   npm run build:tle
//
// The Pages deploy runs it before `npm run build`, and deploys on a daily
// schedule so the snapshot is never more than a day old. It is fail-soft: if
// CelesTrak does not answer, whatever snapshot is already in public/tle/ is
// kept and the build goes on. The client falls back to a live fetch only when
// no snapshot exists at all, which is the fresh-clone case.
// ────────────────────────────────────────────────────────────────────────────
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(HERE, '../public/tle')
const CT = 'https://celestrak.org/NORAD/elements/gp.php?FORMAT=tle&GROUP='
const UA = 'parallax-build/1.0 (https://github.com/ethan-goldstein/parallax)'

/** Must match GROUPS in src/sources/satellites.ts. */
const GROUPS = ['stations', 'gps-ops', 'science', 'visual']

/** One request at a time, a second apart. CelesTrak is a one-person site. */
const DELAY_MS = 1000
const TIMEOUT_MS = 20_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchGroup(group) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${CT}${group}`, {
      headers: { 'user-agent': UA, accept: 'text/plain' },
      signal: ctl.signal,
    })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const text = await res.text()
    // A blocked address gets an HTML page with a 200, not a 403. Refuse to
    // write anything that does not parse as element sets.
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
    const records = lines.filter((l) => l.startsWith('1 ')).length
    if (records === 0 || lines.length < 3) throw new Error('response contained no element sets')
    return { text, records }
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })

  let previous = null
  try {
    previous = JSON.parse(await readFile(resolve(OUT_DIR, 'manifest.json'), 'utf8'))
  } catch {
    // First run, or no snapshot committed. Both fine.
  }

  const manifest = { fetchedAt: new Date().toISOString(), groups: {} }
  let failed = 0

  for (const group of GROUPS) {
    try {
      const { text, records } = await fetchGroup(group)
      await writeFile(resolve(OUT_DIR, `${group}.txt`), text)
      manifest.groups[group] = { records }
      console.log(`  ${group.padEnd(9)} ${String(records).padStart(4)} element sets`)
    } catch (err) {
      failed++
      console.error(`  ${group.padEnd(9)} FAILED: ${err.message ?? err}`)
    }
    await sleep(DELAY_MS)
  }

  if (failed === GROUPS.length) {
    // Nothing fetched. Leave the previous snapshot and its manifest alone,
    // because an honest old date beats a fresh date over stale files.
    console.error(
      previous
        ? `==> CelesTrak unreachable; keeping the snapshot from ${previous.fetchedAt}`
        : '==> CelesTrak unreachable and no previous snapshot; the client will fetch live',
    )
    process.exitCode = 0
    return
  }

  if (failed > 0 && previous) {
    // Partial: carry forward the record counts for the groups that did not
    // refresh, but stamp the manifest with the OLDER date. A viewer reading
    // "fetched at" should get the age of the stalest file, not the freshest.
    for (const g of GROUPS) {
      if (!manifest.groups[g] && previous.groups?.[g]) manifest.groups[g] = previous.groups[g]
    }
    manifest.fetchedAt = previous.fetchedAt
    manifest.partial = true
  }

  await writeFile(resolve(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`==> wrote ${OUT_DIR} (${GROUPS.length - failed}/${GROUPS.length} groups)`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
