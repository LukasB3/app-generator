import { z } from 'zod'

const secret = z.string().min(32)

const schema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(8787),
  DATA_DIR: z.string().default('/var/lib/app-generator'),
  WEB_ORIGIN: z.url(),
  // Where this API is reached from outside. Published apps with live data are
  // pointed there; without it there is no live data.
  API_ORIGIN: z
    .url()
    .transform((url) => new URL(url).origin)
    .optional(),

  TURNSTILE_SECRET: z.string().min(1),
  IP_HASH_SECRET: secret,
  PROXY_SIGNING_SECRET: secret,

  PROXY_URL: z.url().default('http://127.0.0.1:8788'),
  SCREEN_MODEL: z.string().default('claude-haiku-5-5'),

  SANDBOX_LAUNCHER: z.string().default('/usr/local/sbin/ag-sandbox'),
  LIBS_DIR: z.string().default('/opt/app-generator/sandbox/libs'),

  JOB_TIMEOUT_S: z.coerce.number().int().default(900),
  PROMPT_MAX_CHARS: z.coerce.number().int().default(1000),
  QUEUE_MAX: z.coerce.number().int().default(10),
  JOBS_PER_IP_PER_HOUR: z.coerce.number().int().default(3),
  JOBS_PER_HOUR: z.coerce.number().int().default(10),
  JOBS_PER_DAY: z.coerce.number().int().default(30),
  // What finished jobs may have cost before new ones are turned away. The cap
  // for a single job is the key proxy's (MAX_COST_USD_PER_JOB).
  VISITOR_DAILY_BUDGET_USD: z.coerce.number().positive().default(5),
  DAILY_BUDGET_USD: z.coerce.number().positive().default(10),
  MONTHLY_BUDGET_USD: z.coerce.number().positive().default(90),
  // How long an app stays online: built anonymously, or by someone logged in.
  APP_TTL_H: z.coerce.number().int().positive().default(24),
  USER_APP_TTL_H: z.coerce.number().int().positive().default(240),

  // The Supabase project that holds the accounts. Without it nobody can log
  // in and everything else works as before. The key is the publishable one.
  SUPABASE_URL: z.url().optional(),
  SUPABASE_KEY: z.string().min(1).optional(),

  // The database gateway, which creates and removes the tables of generated
  // apps. Without its secret the orchestrator leaves it alone.
  GATE_URL: z.url().default('http://127.0.0.1:8789'),
  GATE_SIGNING_SECRET: secret.optional(),

  APPS_REPO: z.string().default('git@github.com:LukasB3/app-generator-apps.git'),
  APPS_BASE_URL: z.url().default('https://lukasb3.github.io/app-generator-apps'),
  DEPLOY_KEY_PATH: z.string().default('/etc/app-generator/deploy_key'),
  KNOWN_HOSTS_PATH: z.string().default('/etc/app-generator/known_hosts'),
  PUBLISH_WAIT_S: z.coerce.number().int().default(300),
})

export type Config = z.infer<typeof schema>

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => schema.parse(env)
