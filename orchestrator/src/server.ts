import { createHmac, randomBytes } from 'node:crypto'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyReply } from 'fastify'
import type { OutgoingHttpHeaders } from 'node:http'
import { z } from 'zod'
import type { Config } from './config.js'
import type { Job, JobEvent, Store } from './store.js'
import type { CaptchaCheck } from './turnstile.js'
import type { Worker } from './worker.js'

const HOUR = 3_600_000
const MAX_STREAMS = 200
const JOB_ID = /^[a-z0-9]{20}$/

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

// 100 random bits: the id doubles as the capability to watch a job.
export const newJobId = () => Array.from(randomBytes(20), (byte) => ALPHABET[byte % 32]).join('')

// One IPv6 customer usually owns a whole /64, so that is what gets limited.
export const clientKey = (ip: string) => (ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip)

export interface ServerDeps {
  cfg: Config
  store: Store
  worker: Worker
  captcha: CaptchaCheck
}

export const buildServer = async ({ cfg, store, worker, captcha }: ServerDeps) => {
  // Caddy on the same host is the only client, so its forwarded address is trusted.
  // Request logs carry no client address: visitors are only ever stored as keyed hashes.
  const app = Fastify({
    trustProxy: '127.0.0.1',
    bodyLimit: 16_384,
    logger: { level: 'info', serializers: { req: (req) => ({ method: req.method, url: req.url }) } },
  })
  await app.register(cors, { origin: cfg.WEB_ORIGIN, methods: ['GET', 'POST'] })
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' })

  const submission = z.object({
    prompt: z
      .string()
      .transform((text) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim())
      .pipe(z.string().min(5).max(cfg.PROMPT_MAX_CHARS)),
    captchaToken: z.string().min(1).max(4096),
  })

  // `now` lets the page line its own clock up with the event timestamps.
  const view = (job: Job) => ({ id: job.id, status: job.status, position: store.position(job.id), url: job.url, error: job.error, now: Date.now() })
  const hashIp = (ip: string) => createHmac('sha256', cfg.IP_HASH_SECRET).update(clientKey(ip)).digest('hex').slice(0, 32)
  const refuse = (reply: FastifyReply, status: number, error: string) => reply.code(status).send({ error })

  app.get('/api/health', () => ({ ok: true }))

  app.post('/api/jobs', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = submission.safeParse(req.body)
    if (!parsed.success) return refuse(reply, 400, `Please describe your app in 5 to ${cfg.PROMPT_MAX_CHARS} characters.`)
    if (!(await captcha(parsed.data.captchaToken, req.ip))) return refuse(reply, 403, 'The captcha check failed. Please try again.')

    const now = Date.now()
    const ipHash = hashIp(req.ip)
    if (store.countSince(now - HOUR, ipHash) >= cfg.JOBS_PER_IP_PER_HOUR) return refuse(reply, 429, 'You have reached the hourly limit. Please come back later.')
    if (store.countSince(now - HOUR) >= cfg.JOBS_PER_HOUR || store.countSince(now - 24 * HOUR) >= cfg.JOBS_PER_DAY) return refuse(reply, 429, 'The app generator has reached its capacity for now. Please come back later.')
    if (store.queuedCount() >= cfg.QUEUE_MAX) return refuse(reply, 429, 'The queue is full right now. Please try again in a few minutes.')

    const id = newJobId()
    store.createJob(id, parsed.data.prompt, ipHash, now)
    worker.kick()
    return reply.code(202).send(view(store.getJob(id)!))
  })

  app.get<{ Params: { id: string } }>('/api/jobs/:id', (req, reply) => {
    const job = JOB_ID.test(req.params.id) ? store.getJob(req.params.id) : undefined
    if (!job) return refuse(reply, 404, 'Unknown job.')
    return { ...view(job), events: store.events(job.id) }
  })

  let streams = 0
  app.get<{ Params: { id: string } }>('/api/jobs/:id/events', (req, reply) => {
    const job = JOB_ID.test(req.params.id) ? store.getJob(req.params.id) : undefined
    if (!job) return refuse(reply, 404, 'Unknown job.')
    if (streams >= MAX_STREAMS) return refuse(reply, 503, 'Too many open connections.')

    streams++
    reply.hijack()
    const res = reply.raw
    res.writeHead(200, { ...(reply.getHeaders() as OutgoingHttpHeaders), 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })

    const send = (name: string, data: unknown, id?: number) => {
      if (!res.writableEnded) res.write(`${id ? `id: ${id}\n` : ''}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    const sendState = () => send('state', view(store.getJob(job.id)!))
    let lastSeq = Number(req.headers['last-event-id']) || 0
    const sendEvent = (event: JobEvent) => {
      if (event.seq <= lastSeq) return
      lastSeq = event.seq
      send('progress', event, event.seq)
      if (event.type === 'status' && (event.data === 'done' || event.data === 'failed')) {
        sendState()
        res.end()
      }
    }

    const heartbeat = setInterval(() => res.writableEnded || res.write(': ping\n\n'), 20_000)
    worker.on(`job:${job.id}`, sendEvent)
    worker.on('queue', sendState)
    res.on('close', () => {
      streams--
      clearInterval(heartbeat)
      worker.off(`job:${job.id}`, sendEvent)
      worker.off('queue', sendState)
    })

    sendState()
    for (const event of store.events(job.id, lastSeq)) sendEvent(event)
  })

  return app
}
