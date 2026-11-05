import { createProxy } from './proxy.js'

const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback
  if (!value) throw new Error(`${name} is required`)
  return value
}

const server = createProxy({
  apiKey: env('ANTHROPIC_API_KEY'),
  signingSecret: env('PROXY_SIGNING_SECRET'),
  policy: {
    models: env('ALLOWED_MODELS', 'claude-sonnet-5-5,claude-haiku-4-5-20251001,claude-haiku-5-5').split(','),
    maxTokens: Number(env('MAX_TOKENS', '16000')),
    maxBodyBytes: Number(env('MAX_BODY_BYTES', '2000000')),
    maxRequestsPerJob: Number(env('MAX_REQUESTS_PER_JOB', '60')),
    maxOutputTokensPerJob: Number(env('MAX_OUTPUT_TOKENS_PER_JOB', '120000')),
  },
})

server.listen(Number(env('PORT', '8080')), '0.0.0.0', () => console.log('key proxy listening'))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
