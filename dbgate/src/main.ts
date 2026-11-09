import { readFileSync } from 'node:fs'
import pg from 'pg'
import { createGate } from './db.js'
import { createServer } from './server.js'

const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback
  if (!value) throw new Error(`${name} is required`)
  return value
}

const signingSecret = env('GATE_SIGNING_SECRET')
if (signingSecret.length < 32) throw new Error('GATE_SIGNING_SECRET is too short')

// The connection is encrypted and the server has to prove who it is. Supabase
// signs its certificates with an authority of its own, whose certificate ships
// with this image. Only a test database on the same machine is talked to in the clear.
const ssl = process.env.PGSSLMODE === 'disable' ? false : { ca: readFileSync(new URL('../supabase-ca.crt', import.meta.url), 'utf8') }

const pool = new pg.Pool({
  host: env('PGHOST'),
  port: Number(env('PGPORT', '5432')),
  user: env('PGUSER'),
  password: env('PGPASSWORD'),
  database: env('PGDATABASE', 'postgres'),
  ssl,
  // The role may hold three connections. Idle ones are given back quickly: the gateway is asked a few times an hour.
  max: 2,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
})
pool.on('error', (error) => console.log(`idle connection lost: ${error.message}`))

const gate = createGate(pool)
const server = createServer({ gate, signingSecret })

server.listen(Number(env('PORT', '8080')), '0.0.0.0', () => console.log('database gateway listening'))
gate.ready().catch((error: Error) => console.log(`not ready: ${error.message}`))
process.on('SIGTERM', () => server.close(() => void pool.end().then(() => process.exit(0))))
