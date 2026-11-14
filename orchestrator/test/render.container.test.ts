import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Config } from '../src/config.js'
import { loadLibs } from '../src/pipeline.js'
import { openApp } from '../src/render.js'
import { validateWorkspace } from '../src/validate.js'

// The browser check for real: the launcher, the image, gVisor and a browser,
// against the small apps in render/fixtures. It needs what the server has:
// sudo without a password, Docker with the runsc runtime, the image
// ag-render:latest and /etc/app-generator/sandbox.conf. CI's "render" job sets
// that up; anywhere else it runs with TEST_RENDER=1.
const root = join(import.meta.dirname, '../..')
const cfg = { SANDBOX_LAUNCHER: join(root, 'infra/ag-sandbox') } as Config
const libs = await loadLibs(join(root, 'sandbox/libs'))
const database = { url: 'https://project.example', key: 'public-key', prefix: 'afixture_' }
const liveData = 'https://api.example/api/data/'
const ID = 'fixturefixturefixtur'

const look = async (fixture: string, shared = false) => {
  const checked = await validateWorkspace(join(root, 'render/fixtures', fixture), { jobId: ID, libs, badgeUrl: 'https://app-generator.example', ...(shared ? { database, liveData } : {}) })
  const started = Date.now()
  const seen = await openApp(cfg, {
    jobId: ID,
    base: `https://apps.example/apps/${ID}/`,
    files: checked.files,
    sources: checked.sources,
    ...(shared ? { database: { url: database.url, prefix: database.prefix, tables: ['entries'] }, liveData } : {}),
  })
  return { ...seen, ms: Date.now() - started }
}

describe.runIf(process.env.TEST_RENDER === '1')('the browser check, for real', { timeout: 60_000 }, () => {
  it('finds nothing wrong with a sound app and returns a picture of each view', async () => {
    const seen = await look('clean')
    expect(seen).toMatchObject({ ran: true, problems: [] })
    expect([...seen.pictures.keys()]).toEqual(['phone', 'desktop'])
    expect(seen.pictures.get('phone')!.length).toBeGreaterThan(2_000)
    expect(seen.ms).toBeLessThan(15_000)
  })

  it('lets a page use its tables and live data exactly as a published page does', async () => {
    // Preflights, the page's own policy and the two bundled libraries are the real ones.
    expect(await look('shared', true)).toMatchObject({ ran: true, problems: [] })
  })

  it('reports a script that fails and a value that went missing', async () => {
    expect((await look('throws')).problems).toEqual([
      "A script fails when the page loads: TypeError: Cannot read properties of null (reading 'addEventListener') (app.js:4)",
      'The page shows "Basket Total: undefined" when it loads: a value is missing where a number or a text should be.',
    ])
  })

  it('reports an error that the app caught and put on the page', async () => {
    expect((await look('caught')).problems).toEqual([
      `The page shows the message of a script error when it loads: "Could not load rates: Cannot set properties of null (setting 'textContent'). Try again later.". Something in the app fails behind it. Find the cause and fix it.`,
    ])
  })

  it('reports a page that is wider than a phone', async () => {
    expect((await look('overflows')).problems).toEqual(['On a phone (390 px wide) the page is 555 px wider than the screen and scrolls sideways. The widest elements: div.grid.'])
  })

  it('reports what the policy of a published page blocks', async () => {
    const { problems } = await look('blocked')
    expect(problems).toContain("The published page's policy blocks something the page tries when it loads (connect-src, quotes.json). A page cannot fetch files or load anything from outside the app: keep data in a .js file.")
  })

  it('comes back from a page that never stops working', async () => {
    const seen = await look('hangs')
    expect(seen.problems).toEqual(['The page did not finish loading in a browser within four seconds.', 'The page stops responding in a browser shortly after it loads: a script keeps it busy.'])
    expect(seen.ms).toBeLessThan(20_000)
  })
})
