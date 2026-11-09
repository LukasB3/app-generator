import { createHmac, randomBytes } from 'node:crypto'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import type { OutgoingHttpHeaders } from 'node:http'
import { z } from 'zod'
import { AuthError, type Auth } from './auth.js'
import type { Config } from './config.js'
import type { PromptScreen } from './screen.js'
import type { Job, JobEvent, Store, Who } from './store.js'
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
  screen: PromptScreen
  auth: Auth
}

const SCREENED_OUT = {
  nonsense: 'That does not read like an app idea yet. Describe what the app should do, for example "a 5-minute timer with a QR code".',
  abusive: 'This request is against the rules of this demo: no hateful, sexual or unlawful content. Please describe a different app.',
}

export const buildServer = async ({ cfg, store, worker, captcha, screen, auth }: ServerDeps) => {
  // Caddy on the same host is the only client, so its forwarded address is trusted.
  // Request logs carry no client address: visitors are only ever stored as keyed hashes.
  const app = Fastify({
    trustProxy: '127.0.0.1',
    bodyLimit: 16_384,
    logger: { level: 'info', serializers: { req: (req) => ({ method: req.method, url: req.url }) } },
  })
  await app.register(cors, { origin: cfg.WEB_ORIGIN, methods: ['GET', 'POST'], allowedHeaders: ['content-type', 'authorization'] })
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' })

  const submission = z.object({
    prompt: z
      .string()
      .transform((text) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim())
      .pipe(z.string().min(5).max(cfg.PROMPT_MAX_CHARS)),
    captchaToken: z.string().min(1).max(4096),
  })

  // `now` lets the page line its own clock up with the event timestamps.
  const view = (job: Job) => ({
    id: job.id,
    status: job.status,
    position: store.position(job.id),
    url: job.url,
    error: job.error,
    expiresAt: store.getApp(job.appId)?.expiresAt ?? null,
    now: Date.now(),
  })
  const hashIp = (ip: string) => createHmac('sha256', cfg.IP_HASH_SECRET).update(clientKey(ip)).digest('hex').slice(0, 32)
  const refuse = (reply: FastifyReply, status: number, error: string) => reply.code(status).send({ error })
  // The account behind a request, or null for a visitor who is not logged in.
  // A login that does not verify is answered here, and undefined comes back.
  const whoIs = (req: FastifyRequest, reply: FastifyReply) =>
    auth(req.headers.authorization).catch((error: unknown) => {
      if (!(error instanceof AuthError)) throw error
      refuse(reply, 401, 'Your login is no longer valid. Please log in again.')
      return undefined
    })

  // A visitor is counted by address and, when logged in, by account as well:
  // an account can never get more than an address already does.
  // A job's cost is known when it ends, so jobs still waiting or running can
  // take the total past a budget, each by at most the cap for a single job.
  const limitError = (visitor: Who[], now = Date.now()) => {
    const jobs = (hours: number, who?: Who) => store.countSince(now - hours * HOUR, who)
    const usd = (hours: number, who?: Who) => store.costSince(now - hours * HOUR, who) / 1e6
    if (visitor.some((who) => jobs(1, who) >= cfg.JOBS_PER_IP_PER_HOUR)) return 'You have reached the hourly limit. Please come back later.'
    if (visitor.some((who) => usd(24, who) >= cfg.VISITOR_DAILY_BUDGET_USD)) return 'You have reached the limit for today. Please come back tomorrow.'
    if (jobs(1) >= cfg.JOBS_PER_HOUR || jobs(24) >= cfg.JOBS_PER_DAY || usd(24) >= cfg.DAILY_BUDGET_USD || usd(30 * 24) >= cfg.MONTHLY_BUDGET_USD)
      return 'The app generator has reached its capacity for now. Please come back later.'
    if (store.queuedCount() >= cfg.QUEUE_MAX) return 'The queue is full right now. Please try again in a few minutes.'
  }

  // Queues a job that has passed its route's own checks: the first build of a
  // new app, or a change to the app in `appId`.
  const submit = async (req: FastifyRequest, reply: FastifyReply, prompt: string, userId: string | null, app: { expiresAt: number } | { appId: string }) => {
    const ipHash = hashIp(req.ip)
    const visitor: Who[] = userId ? [{ ipHash }, { userId }] : [{ ipHash }]
    const obstacle = (): [number, string] | undefined => {
      if ('appId' in app && store.hasOpenJob(app.appId)) return [409, 'This app is being built or changed right now. Wait until that is finished.']
      const overLimit = limitError(visitor)
      if (overLimit) return [429, overLimit]
    }
    const blocked = obstacle()
    if (blocked) return refuse(reply, ...blocked)

    const id = newJobId()
    const verdict = await screen(prompt, id)
    if (verdict !== 'ok') {
      req.log.info({ verdict }, 'prompt screened out')
      return refuse(reply, 422, SCREENED_OUT[verdict])
    }

    // Other submissions may have been queued while the screen was running.
    const blockedNow = obstacle()
    if (blockedNow) return refuse(reply, ...blockedNow)
    store.createJob({ id, prompt, ipHash, userId, ...app })
    worker.kick()
    return reply.code(202).send(view(store.getJob(id)!))
  }

  app.get('/api/health', () => ({ ok: true }))

  app.post('/api/jobs', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = submission.safeParse(req.body)
    if (!parsed.success) return refuse(reply, 400, `Please describe your app in 5 to ${cfg.PROMPT_MAX_CHARS} characters.`)
    // Before the captcha, which works only once: a stale login should not cost the visitor a solved one.
    const userId = await whoIs(req, reply)
    if (userId === undefined) return reply
    if (!(await captcha(parsed.data.captchaToken, req.ip))) return refuse(reply, 403, 'The captcha check failed. Please try again.')
    return submit(req, reply, parsed.data.prompt, userId, { expiresAt: Date.now() + (userId ? cfg.USER_APP_TTL_H : cfg.APP_TTL_H) * HOUR })
  })

  // A change to an app: a new job on the same app, for its owner only. To
  // everyone else the app does not exist here, whether or not it does.
  app.post<{ Params: { id: string } }>('/api/apps/:id/edits', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = submission.safeParse(req.body)
    if (!parsed.success) return refuse(reply, 400, `Please describe the change in 5 to ${cfg.PROMPT_MAX_CHARS} characters.`)
    const userId = await whoIs(req, reply)
    if (userId === undefined) return reply
    if (userId === null) return refuse(reply, 401, 'Please log in to change an app.')
    const owned = JOB_ID.test(req.params.id) ? store.getApp(req.params.id) : undefined
    if (!owned || owned.ownerId !== userId || owned.expiresAt <= Date.now()) return refuse(reply, 404, 'Unknown app.')
    if (!owned.currentJobId) return refuse(reply, 409, 'This app cannot be changed: it has not been published yet, or it was built before changes were possible.')
    // A change needs time to be built, and it never moves the end of the app.
    if (owned.expiresAt - Date.now() < HOUR) return refuse(reply, 409, 'This app is removed within the hour, so it can no longer be changed.')
    if (!(await captcha(parsed.data.captchaToken, req.ip))) return refuse(reply, 403, 'The captcha check failed. Please try again.')
    return submit(req, reply, parsed.data.prompt, userId, { appId: owned.id })
  })

  app.get('/api/apps', async (req, reply) => {
    const userId = await whoIs(req, reply)
    if (userId === undefined) return reply
    if (userId === null) return refuse(reply, 401, 'Please log in to see your apps.')
    return { apps: store.appsOf(userId), now: Date.now() }
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
