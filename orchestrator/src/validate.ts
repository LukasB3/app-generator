import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { parse, serialize, type DefaultTreeAdapterTypes as T } from 'parse5'
import type { Database } from './gate.js'
import { GATE_TOKEN_PATTERN, TOKEN_PATTERN } from './token.js'

// Everything the agent wrote is treated as hostile. Only what passes these
// checks is published, and HTML is re-serialised with our own CSP on top.

export const LIMITS = { files: 30, depth: 3, fileBytes: 300_000, totalBytes: 1_500_000 }

// A page may send requests nowhere, with two exceptions, each for a page that
// loads the library for it: the Data API of the database for an app with
// tables, and this server's live data routes. In both cases only that path.
const policy = (connect = "'none'") =>
  [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')
export const CSP = policy()
const DB_LIB = 'lib/db.js'
const DATA_LIB = 'lib/data.js'
// Rows in a table come from strangers. Written into a page as HTML, their
// markup would become part of it for every later visitor. Scripts in it stay
// blocked, but a fake form or a redirect would not. This catches the honest
// mistake; a script that is out to do it can hide the name.
const HTML_SINKS = /\b(innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML|setHTMLUnsafe|createContextualFragment)\b|\bdocument\s*\.\s*write(ln)?\s*\(/

const EXTENSIONS = new Set(['html', 'css', 'js', 'json', 'txt'])
const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const BANNED_TAGS = new Set(['base', 'iframe', 'frame', 'frameset', 'object', 'embed', 'portal', 'applet'])
const URL_ATTRS = new Set(['src', 'href', 'action', 'formaction', 'poster', 'data', 'srcset', 'ping', 'background', 'manifest', 'xlink:href'])
const SECRETS: [string, RegExp][] = [
  ['an Anthropic API key', /sk-ant-[a-z0-9_-]{20,}/i],
  ['a GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['a sandbox credential', TOKEN_PATTERN],
  ['a sandbox credential', GATE_TOKEN_PATTERN],
]
const ALLOWED_ABSOLUTE = /^https?:\/\/www\.w3\.org\//

export class ValidationError extends Error {
  constructor(public problems: string[]) {
    super(`validation failed: ${problems.join('; ')}`)
  }
}

export interface ValidateOptions {
  jobId: string
  libs: Map<string, Buffer>
  badgeUrl: string
  extraSecrets?: string[]
  // Set when the app has tables: where its pages find them.
  database?: Database
  // The address of the live data routes, if this server offers them.
  liveData?: string
}

const safeName = (path: string) => (path.split('/').every((s) => SEGMENT.test(s)) ? path : '(unnamed file)')

const walk = async (root: string, problems: string[]) => {
  const files: string[] = []
  const visit = async (dir: string, rel: string, depth: number) => {
    for (const name of (await readdir(dir)).sort()) {
      const path = rel ? `${rel}/${name}` : name
      // The agent's copy of the bundled libraries is never read: they are published from ours.
      if (path === 'lib') continue
      const stat = await lstat(join(dir, name))
      if (!SEGMENT.test(name)) problems.push(`file name not allowed: ${safeName(path)}`)
      else if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) problems.push(`${path}: only regular files are allowed`)
      else if (stat.isDirectory()) {
        if (depth >= LIMITS.depth) problems.push(`${path}: folders are nested too deeply`)
        else await visit(join(dir, name), path, depth + 1)
      } else if (stat.size > LIMITS.fileBytes) problems.push(`${path}: file is larger than ${LIMITS.fileBytes / 1000} kB`)
      else files.push(path)
      if (files.length > LIMITS.files) return
    }
  }
  await visit(root, '', 1)
  return files
}

// Resolves a reference the way a browser would and returns the target inside
// the app folder, or null if it points anywhere else.
const localTarget = (fromFile: string, ref: string) => {
  const value = ref.trim()
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('/') || value.startsWith('\\') || /[\u0000-\u001f]/.test(value)) return null
  const pathPart = decodeURI(value.split(/[?#]/)[0] ?? '')
  const resolved = posix.normalize(posix.join(posix.dirname(fromFile), pathPart)).replace(/\/+$/, '')
  return resolved.startsWith('..') ? null : resolved === '.' ? '' : resolved
}

const checkUrl = (file: string, rawTag: string, attr: string, value: string, known: Set<string>, problems: string[]) => {
  const tag = rawTag.replace(/[^a-z0-9-]/gi, '').slice(0, 20)
  const v = value.trim()
  if (v === '' || v.startsWith('#')) return
  if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(v) && (tag === 'img' || tag === 'link')) return
  if (attr === 'action' || attr === 'formaction') return void problems.push(`${file}: forms must not submit anywhere (<${tag} ${attr}>)`)
  let target: string | null = null
  try {
    target = localTarget(file, v)
  } catch {
    /* malformed escape: treated as not local */
  }
  if (target === null) return void problems.push(`${file}: <${tag} ${attr}> must point to a file inside the app, not to an external or absolute URL`)
  if (target !== '' && !known.has(target) && !known.has(`${target}/index.html`)) problems.push(`${file}: <${tag} ${attr}> points to a missing file (${safeName(target)})`)
}

// The host lets browsers keep a file for ten minutes. A changed app is
// published under the same address, so links to its own files carry the job
// that built them, and a new build is fetched at once. This runs after the
// check and only adds a query, which the check ignores anyway.
const versioned = (value: string, jobId: string) => {
  const v = value.trim()
  if (!v || v.startsWith('#') || v.includes('?') || /^data:/i.test(v)) return value
  const [path, fragment] = v.split('#', 2)
  return `${path}?v=${jobId}${fragment === undefined ? '' : `#${fragment}`}`
}

const attr = (el: T.Element, name: string) => el.attrs.find((a) => a.name === name)?.value

const findElement = (node: T.ParentNode, tag: string): T.Element | undefined => {
  for (const child of node.childNodes) {
    if (!('tagName' in child)) continue
    if (child.tagName === tag) return child
    const found = findElement(child, tag)
    if (found) return found
  }
}

const element = (tagName: string, attrs: Record<string, string>, parentNode: T.ParentNode): T.Element => ({
  nodeName: tagName,
  tagName,
  attrs: Object.entries(attrs).map(([name, value]) => ({ name, value })),
  namespaceURI: 'http://www.w3.org/1999/xhtml' as T.Element['namespaceURI'],
  childNodes: [],
  parentNode,
})

const resolved = (file: string, ref: string) => {
  try {
    return localTarget(file, ref)
  } catch {
    return null
  }
}

type Reach = 'database' | 'liveData'

const checkHtml = (file: string, source: string, known: Set<string>, opts: ValidateOptions, problems: string[], uses: Set<Reach>) => {
  const doc = parse(source)
  let usesDatabase = false
  let usesLiveData = false
  // Nothing the agent wrote may precede our CSP tag except the doctype and <html>.
  doc.childNodes = doc.childNodes.filter((n) => n.nodeName !== '#comment')
  const visit = (node: T.ParentNode) => {
    node.childNodes = node.childNodes.filter((child) => {
      if (!('tagName' in child)) return true
      const tag = child.tagName
      const httpEquiv = attr(child, 'http-equiv')?.toLowerCase()
      // Our own policy and our own meta tags replace whatever the agent supplied.
      if (tag === 'meta' && (httpEquiv === 'content-security-policy' || attr(child, 'name')?.toLowerCase().startsWith('app-generator-'))) return false
      if (BANNED_TAGS.has(tag)) problems.push(`${file}: <${tag}> is not allowed`)
      if (tag === 'meta' && httpEquiv === 'refresh') problems.push(`${file}: meta refresh is not allowed`)
      if (tag === 'script') {
        if (attr(child, 'src') === undefined) problems.push(`${file}: inline <script> is not allowed, move the code into a .js file`)
        else if (!/\.js([?#]|$)/.test(attr(child, 'src')!.trim())) problems.push(`${file}: <script src> must load a .js file`)
        else if (resolved(file, attr(child, 'src')!) === DB_LIB) usesDatabase = true
        else if (resolved(file, attr(child, 'src')!) === DATA_LIB) usesLiveData = true
      }
      if (tag === 'input' && attr(child, 'type')?.toLowerCase() === 'password') problems.push(`${file}: password fields are not allowed`)
      if (/\b(cc-|current-password|new-password|one-time-code)/i.test(attr(child, 'autocomplete') ?? '')) problems.push(`${file}: fields asking for credentials or card data are not allowed`)
      if (tag === 'link' && /\b(preconnect|dns-prefetch|prefetch|preload|modulepreload|prerender)\b/i.test(attr(child, 'rel') ?? '')) problems.push(`${file}: <link rel="${attr(child, 'rel')!.toLowerCase().slice(0, 20)}"> is not allowed`)
      for (const attribute of child.attrs) {
        const { name, value } = attribute
        if (name.startsWith('on')) problems.push(`${file}: inline event handler ${name.slice(0, 20)}= is not allowed, use addEventListener in a .js file`)
        else if (name === 'srcdoc') problems.push(`${file}: srcdoc is not allowed`)
        else if (name === 'style' && /url\s*\(|@import|expression\s*\(/i.test(value)) problems.push(`${file}: style attributes must not load resources`)
        else if (name === 'srcset') for (const part of value.split(',')) checkUrl(file, tag, name, part.trim().split(/\s+/)[0] ?? '', known, problems)
        else if (URL_ATTRS.has(name)) {
          checkUrl(file, tag, name, value, known, problems)
          if (name === 'src' || name === 'href') attribute.value = versioned(value, opts.jobId)
        }
      }
      if (tag === 'style') checkCss(file, child.childNodes.map((n) => ('value' in n ? n.value : '')).join(''), known, problems)
      visit('content' in child ? (child as T.Template).content : child)
      return true
    })
  }
  visit(doc)

  const head = findElement(doc, 'head')
  const body = findElement(doc, 'body')
  if (!head || !body) return void problems.push(`${file}: not a complete HTML document`)
  if (usesDatabase && !opts.database) problems.push(`${file}: loads ${DB_LIB}, but the app has no table. Ask for one with the create_table tool. If you have no such tool, the database is not available: keep the data in the browser and do not load ${DB_LIB}`)
  if (usesLiveData && !opts.liveData) problems.push(`${file}: loads ${DATA_LIB}, but live data is not available here. Build the app without it and do not load ${DATA_LIB}`)
  // Only a page that loads one of the two libraries is told where to ask, and may ask there.
  const database = usesDatabase ? opts.database : undefined
  const liveData = usesLiveData ? opts.liveData : undefined
  if (database) uses.add('database')
  if (liveData) uses.add('liveData')
  const reachable = [database && `${database.url}/rest/v1/`, liveData].filter(Boolean)
  head.childNodes.unshift(
    element('meta', { 'http-equiv': 'Content-Security-Policy', content: reachable.length ? policy(reachable.join(' ')) : CSP }, head),
    element('meta', { name: 'app-generator-job', content: opts.jobId }, head),
    element('meta', { name: 'referrer', content: 'no-referrer' }, head),
    ...(database ? [element('meta', { name: 'app-generator-db', content: JSON.stringify(database) }, head)] : []),
    ...(liveData ? [element('meta', { name: 'app-generator-data', content: liveData }, head)] : []),
  )
  const badge = element('a', { href: opts.badgeUrl, rel: 'noopener', style: BADGE_STYLE }, body)
  // The notice for an app with tables, and the credit the sources of live data ask for.
  const label = ['AI-generated demo from App Generator', ...(database ? ['Anything entered here is public'] : []), ...(liveData ? ['Live data: Open-Meteo.com, ECB via Frankfurter'] : [])]
  badge.childNodes.push({ nodeName: '#text', value: label.length > 1 ? `${label.join('. ')}.` : label[0]!, parentNode: badge })
  body.childNodes.push(badge)
  const html = serialize(doc)
  return html.startsWith('<!DOCTYPE') ? html : `<!DOCTYPE html>${html}`
}

const BADGE_STYLE =
  'position:fixed;right:8px;bottom:8px;z-index:2147483647;padding:4px 10px;border-radius:999px;background:#111;color:#fff;font:12px/1.4 system-ui,sans-serif;text-decoration:none;opacity:.85'

const checkCss = (file: string, source: string, known: Set<string>, problems: string[]) => {
  if (/@import/i.test(source)) problems.push(`${file}: @import is not allowed, link stylesheets from the HTML`)
  for (const match of source.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    const ref = match[2] ?? ''
    if (/^data:(image\/(png|jpeg|gif|webp|svg\+xml)|font\/woff2)[;,]/i.test(ref) || ref.startsWith('#')) continue
    let target: string | null = null
    try {
      target = localTarget(file, ref)
    } catch {
      /* treated as not local */
    }
    if (target === null || !known.has(target)) problems.push(`${file}: url() must point to a file inside the app`)
  }
}

const checkScript = (file: string, source: string, opts: ValidateOptions, problems: string[]) => {
  if (opts.database && HTML_SINKS.test(source)) problems.push(`${file}: innerHTML, outerHTML, insertAdjacentHTML and document.write are not allowed in an app with a database, because its rows are written by strangers. Build elements with createElement and set their text with textContent. For a QR code, draw on a canvas with qr.renderTo2dContext`)
  for (const match of source.matchAll(/(?:https?:|wss?:)\/\/[^\s'"`)<>]+/gi))
    if (!ALLOWED_ABSOLUTE.test(match[0])) {
      problems.push(`${file}: external URLs are not allowed in scripts`)
      break
    }
  if (/\bimportScripts\s*\(|\bnavigator\s*\.\s*serviceWorker\b/.test(source)) problems.push(`${file}: workers loading other scripts are not allowed`)
}

// Returns the publishable files, and the text of the agent's own files exactly
// as it was checked, for a later change to start from. Throws ValidationError
// listing every problem, phrased so it can be handed back to the agent for one
// repair attempt.
export const validateWorkspace = async (root: string, opts: ValidateOptions) => {
  const problems: string[] = []
  const paths = await walk(root, problems)
  if (paths.length > LIMITS.files) throw new ValidationError([`too many files (limit ${LIMITS.files})`])

  const sources = new Map<string, string>()
  let total = 0
  for (const path of paths) {
    const ext = path.split('.').pop()!.toLowerCase()
    if (!path.includes('.') || !EXTENSIONS.has(ext)) {
      problems.push(`${path}: file type not allowed (use ${[...EXTENSIONS].join(', ')})`)
      continue
    }
    const bytes = await readFile(join(root, path))
    total += bytes.length
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    if (text.includes('�') || text.includes('\u0000')) problems.push(`${path}: must be plain UTF-8 text`)
    else sources.set(path, text)
  }
  if (total > LIMITS.totalBytes) problems.push(`app is larger than ${LIMITS.totalBytes / 1000} kB in total`)
  if (!sources.has('index.html')) problems.push('index.html is missing in the top folder')

  const known = new Set([...sources.keys(), ...[...opts.libs.keys()].map((name) => `lib/${name}`)])
  const out = new Map<string, Buffer>()
  // What the app's pages were allowed to reach beyond their own folder.
  const uses = new Set<Reach>()
  for (const [path, text] of sources) {
    for (const [label, pattern] of SECRETS) if (pattern.test(text)) problems.push(`${path}: contains what looks like ${label}`)
    for (const secret of opts.extraSecrets ?? []) if (secret && text.includes(secret)) problems.push(`${path}: contains a server secret`)

    const ext = path.split('.').pop()!.toLowerCase()
    let result = text
    if (ext === 'html') result = checkHtml(path, text, known, opts, problems, uses) ?? text
    if (ext === 'css') checkCss(path, text, known, problems)
    if (ext === 'js') checkScript(path, text, opts, problems)
    if (ext === 'json')
      try {
        JSON.parse(text)
      } catch {
        problems.push(`${path}: not valid JSON`)
      }
    out.set(path, Buffer.from(result))
  }
  if (problems.length) throw new ValidationError([...new Set(problems)].slice(0, 25))

  // Bundled libraries are always published from our pristine copies, and only
  // the ones the app actually references.
  const referenced = [...sources.values()].join('\n')
  for (const [name, bytes] of opts.libs) if (referenced.includes(`lib/${name}`)) out.set(`lib/${name}`, bytes)
  return { files: out, sources, uses }
}
