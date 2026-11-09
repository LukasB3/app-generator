import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
    const out = await validateWorkspace(
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
  })

  it('replaces a CSP the agent supplied and drops leading comments', async () => {
    const out = await validateWorkspace(
      await workspace({ 'index.html': `<!-- x --><!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body></body></html>` }),
      opts,
    )
    const html = out.get('index.html')!.toString()
    expect(html).not.toContain('default-src *')
    expect(html).not.toContain('<!-- x -->')
    expect(html.match(/Content-Security-Policy/g)).toHaveLength(1)
  })

  it('ships bundled libraries from the pristine copy, and only when referenced', async () => {
    const used = await validateWorkspace(await workspace({ 'index.html': page('<script src="lib/qrcode.js"></script>'), 'lib/qrcode.js': 'tampered()' }), opts)
    expect(used.get('lib/qrcode.js')!.toString()).toBe('/* pristine */')
    const unused = await validateWorkspace(await workspace({ 'index.html': page('hi'), 'lib/qrcode.js': 'x' }), opts)
    expect(unused.has('lib/qrcode.js')).toBe(false)
  })

  it('does not count or read the library folder in the workspace', async () => {
    const files: Record<string, string> = { 'index.html': page('x'), 'lib/chart.js': 'x'.repeat(LIMITS.fileBytes + 1), 'lib/odd name!.js': 'x', 'lib/deep/er/still/x.js': 'x' }
    for (let i = 1; i < LIMITS.files; i++) files[`f${i}.txt`] = 'x'
    const out = await validateWorkspace(await workspace(files), opts)
    expect(out.size).toBe(LIMITS.files)
    expect([...out.keys()].some((path) => path.startsWith('lib/'))).toBe(false)
  })

  it('ships the real bundled libraries to an app that uses them', async () => {
    const libsDir = join(import.meta.dirname, '../../sandbox/libs')
    const libs = new Map(await Promise.all((await readdir(libsDir)).filter((name) => name.endsWith('.js')).map(async (name) => [name, await readFile(join(libsDir, name))] as const)))
    const out = await validateWorkspace(
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
