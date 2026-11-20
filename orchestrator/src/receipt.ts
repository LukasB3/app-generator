// The receipt of a build: how long each step took, what the agent did and
// what it cost. Cost and tokens come from the key proxy's meter, the times
// from the job's own status events. The tool calls and the model are read off
// the agent's stream, which leaves a container that may be hijacked, so they
// are names from a fixed list and capped counts, nothing more.

// What a job used, as the key proxy counted it. The prompt screen runs with
// the job's own token, so it is part of this.
export interface Usage {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costMicroUsd: number
}

export const TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'database'] as const
export type Tool = (typeof TOOLS)[number] | 'other'
const MAX_CALLS = 9_999

// A tool the agent called, by the group it is counted in.
export const toolGroup = (name: string): Tool => ((TOOLS as readonly string[]).includes(name) && name !== 'database' ? (name as Tool) : name.startsWith('mcp__db__') ? 'database' : 'other')

export const countCall = (calls: Partial<Record<Tool, number>>, name: string) => {
  const group = toolGroup(name)
  calls[group] = Math.min(MAX_CALLS, (calls[group] ?? 0) + 1)
}

// The model that answered most often.
export const mostOften = (counts: Map<string, number>) => [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]

// What the pipeline knows about a build once it has been checked.
export interface BuildFacts {
  model?: string
  tools?: Partial<Record<Tool, number>>
  // The agent's own files, as they are published.
  files?: { count: number; bytes: number }
  // The bundled libraries that go out with the app: "chart.js", "fonts/inter".
  libs?: string[]
  // Which check sent the app back for the one repair round.
  repair?: 'checker' | 'browser' | null
  browser?: 'clean' | 'findings' | 'not run' | 'off'
}

// What is kept with a job: the facts, the time the screen took and the tokens.
export interface Stored extends BuildFacts {
  screenMs?: number
  usage?: Omit<Usage, 'costMicroUsd'>
}

// A library by its path under lib/: a script by its file, a folder by the folder.
export const libraryNames = (paths: Iterable<string>) => {
  const names = new Set<string>()
  for (const path of paths) {
    if (!path.startsWith('lib/')) continue
    const parts = path.slice(4).split('/')
    names.add(parts.length > 1 ? parts.slice(0, -1).join('/') : parts[0]!)
  }
  return [...names].sort()
}

// How long a build spent in each status, in milliseconds. A status that comes
// round twice, as coding and checking do in a repair round, is added up.
export const timeSpent = (statuses: { status: string; at: number }[], end: number) => {
  const spent: Record<string, number> = {}
  statuses.forEach(({ status, at }, index) => (spent[status] = (spent[status] ?? 0) + Math.max(0, (statuses[index + 1]?.at ?? end) - at)))
  return spent
}

const STEPS = ['screening', 'queued', 'preparing', 'coding', 'checking', 'publishing'] as const
export type Step = (typeof STEPS)[number]

export interface Receipt {
  // In seconds, to a tenth. The total runs from the screen to the end of publishing.
  seconds: Record<Step | 'total', number>
  costUsd: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
  requests: number | null
  model: string | null
  tools: Partial<Record<Tool, number>>
  files: { count: number; bytes: number } | null
  libs: string[]
  repair: 'checker' | 'browser' | null
  browser: 'clean' | 'findings' | 'not run' | 'off' | null
}

const tenths = (ms: number) => Math.round(ms / 100) / 10

// Puts a receipt together from what was stored and the job's status events.
export const buildReceipt = (stored: Stored, costMicroUsd: number, events: { ts: number; data: string }[]): Receipt => {
  const end = events.findLast((event) => event.data === 'done' || event.data === 'failed') ?? events.at(-1)
  const before = events.filter((event) => event !== end).map((event) => ({ status: event.data, at: event.ts }))
  const spent = timeSpent(before, end?.ts ?? 0)
  const screening = stored.screenMs ?? 0
  const seconds = Object.fromEntries(STEPS.map((step) => [step, tenths(step === 'screening' ? screening : (spent[step] ?? 0))])) as Record<Step, number>
  const { usage } = stored
  return {
    seconds: { ...seconds, total: tenths(screening + (end && events[0] ? end.ts - events[0].ts : 0)) },
    costUsd: costMicroUsd / 1e6,
    tokens: usage ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite } : null,
    requests: usage?.requests ?? null,
    model: stored.model ?? null,
    tools: stored.tools ?? {},
    files: stored.files ?? null,
    libs: stored.libs ?? [],
    repair: stored.repair ?? null,
    browser: stored.browser ?? null,
  }
}
