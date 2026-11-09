#!/usr/bin/env node
// Prints the statement that gives the database gateway's role its password,
// for pasting into the Supabase SQL editor. The statement holds a SCRAM-SHA-256
// verifier, which is all Postgres ever stores, and not the password itself.
// The password stays in dbgate.env on this server: neither the editor's
// history nor the database log, which records such statements, can give it away.
//
//   ./gate-role.mjs [path to dbgate.env]
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

const file = process.argv[2] ?? '/etc/app-generator/dbgate.env'
const password = /^PGPASSWORD=(.+)$/m.exec(readFileSync(file, 'utf8'))?.[1]
if (!password) {
  console.error(`no PGPASSWORD in ${file}`)
  process.exit(1)
}

// RFC 5802, as Postgres stores it: SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>
const ITERATIONS = 4096
const salt = randomBytes(16)
const salted = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256')
const keyed = (text) => createHmac('sha256', salted).update(text).digest()
const storedKey = createHash('sha256').update(keyed('Client Key')).digest('base64')
const serverKey = keyed('Server Key').toString('base64')

console.log(`alter role ag_gate password 'SCRAM-SHA-256$${ITERATIONS}:${salt.toString('base64')}$${storedKey}:${serverKey}';`)
