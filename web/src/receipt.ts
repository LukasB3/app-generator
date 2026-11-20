// The receipt of a finished build, as the server sends it: how long each step
// took, what the agent did and what it cost.
export interface Receipt {
  seconds: Record<'screening' | 'queued' | 'preparing' | 'coding' | 'checking' | 'publishing' | 'total', number>
  costUsd: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
  requests: number | null
  model: string | null
  tools: Record<string, number>
  files: { count: number; bytes: number } | null
  libs: string[]
  repair: 'checker' | 'browser' | null
  browser: string | null
  source: string
}

// "0.3 s", "52 s", "1:29": the last the way the clock shows it.
export const duration = (seconds: number) => {
  if (seconds < 0.1) return '<0.1 s'
  if (seconds < 1) return `${seconds.toFixed(1)} s`
  if (seconds < 59.5) return `${Math.round(seconds)} s`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

// "1:13", "$0.10", "Sonnet 5.5": a build in a few figures.
export const summary = (receipt: Pick<Receipt, 'seconds' | 'costUsd' | 'model'>) => [duration(receipt.seconds.total), dollars(receipt.costUsd), ...(receipt.model ? [modelName(receipt.model)] : [])]

export const dollars = (usd: number) => (usd < 0.005 ? '<$0.01' : `$${usd.toFixed(2)}`)

// "48k", "1.2k", "940"
const count = (n: number) => (n >= 9_950 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

// "claude-sonnet-5-5" reads as "Sonnet 5.5".
export const modelName = (id: string) => {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id)
  return match ? `${match[1]![0]!.toUpperCase()}${match[1]!.slice(1)} ${match[2]}.${match[3]}` : id
}

const LIBRARIES: Record<string, string> = {
  'chart.js': 'Chart.js',
  'qrcode.js': 'QR code',
  'preact.js': 'Preact',
  'icons.js': 'Lucide icons',
  'db.js': 'Database client',
  'data.js': 'Live data client',
}
const libraryName = (id: string) =>
  LIBRARIES[id] ??
  id
    .replace(/^fonts\//, '')
    .replace(/\.js$/, '')
    .split('-')
    .map((word) => (word === 'jetbrains' ? 'JetBrains' : `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`))
    .join(' ')

const el = (tag: string, text = '', className = '') => {
  const node = document.createElement(tag)
  node.textContent = text
  if (className) node.className = className
  return node
}

const item = (label: string, value: string, detail = '', className = '') => {
  const row = el('div', '', className)
  const figure = el('dd', value)
  if (detail) figure.append(el('small', detail))
  row.append(el('dt', label), figure)
  return row
}

// The figures of a build, for the strip under the steps. Everything the
// server sent is set as text; the one address is used only if it is one.
export const receiptItems = (receipt: Receipt) => {
  const items = [item('Time', duration(receipt.seconds.total), receipt.seconds.queued >= 5 ? `${duration(receipt.seconds.queued)} in line` : '')]
  if (receipt.tokens) {
    const { input, output, cacheRead, cacheWrite } = receipt.tokens
    const read = input + cacheRead + cacheWrite
    items.push(item('Cost', dollars(receipt.costUsd)))
    items.push(item('Tokens', count(read + output), read ? `${Math.round((100 * cacheRead) / read)}% from cache` : ''))
  }
  const calls = Object.values(receipt.tools).reduce((sum, n) => sum + n, 0)
  if (calls) {
    const writes = (receipt.tools.Write ?? 0) + (receipt.tools.Edit ?? 0)
    items.push(item('Tool calls', String(calls), writes ? `${writes} file write${writes === 1 ? '' : 's'}` : ''))
  }
  if (receipt.files) items.push(item('Files', String(receipt.files.count), `${Math.max(1, Math.round(receipt.files.bytes / 1000))} kB`))
  if (receipt.model) items.push(item('Model', modelName(receipt.model)))
  if (receipt.libs.length) items.push(item('Libraries', receipt.libs.map(libraryName).join(', '), '', 'wide'))
  return items
}

export const sourceLink = (receipt: Receipt) => {
  if (!/^https:\/\/github\.com\//.test(receipt.source)) return null
  const link = el('a', 'View source', 'source') as HTMLAnchorElement
  link.href = receipt.source
  link.target = '_blank'
  link.rel = 'noopener'
  return link
}
