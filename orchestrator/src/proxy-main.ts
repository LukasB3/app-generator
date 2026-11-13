import { createProxy, type Usage } from './proxy.js'

const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback
  if (!value) throw new Error(`${name} is required`)
  return value
}

// USD per million tokens, from platform.claude.com/docs/en/about-claude/pricing
// (read 2026-11-13). The meter must never count low: cache writes are priced at
// the one-hour rate, and Haiku 5.5 at its rate for prompts over 100,000 tokens.
// The launcher tells the agent which model to use, but a container could ask
// for any model listed here. Its budget in dollars holds whichever it asks for.
const PRICES = new Map<string, Usage>([
  ['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 4 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 }],
  ['claude-haiku-5-5', { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 1 }],
  ['claude-haiku-4-5-20251001', { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 2 }],
])

const server = createProxy({
  apiKey: env('ANTHROPIC_API_KEY'),
  signingSecret: env('PROXY_SIGNING_SECRET'),
  policy: {
    prices: PRICES,
    maxTokens: Number(env('MAX_TOKENS', '32000')),
    maxBodyBytes: Number(env('MAX_BODY_BYTES', '2000000')),
    maxRequestsPerJob: Number(env('MAX_REQUESTS_PER_JOB', '120')),
    maxOutputTokensPerJob: Number(env('MAX_OUTPUT_TOKENS_PER_JOB', '250000')),
    maxCostUsdPerJob: Number(env('MAX_COST_USD_PER_JOB', '4')),
  },
})

server.listen(Number(env('PORT', '8080')), '0.0.0.0', () => console.log('key proxy listening'))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
