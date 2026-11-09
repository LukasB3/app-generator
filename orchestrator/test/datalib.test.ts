import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { beforeEach, describe, expect, it } from 'vitest'

// lib/data.js, run against stand-ins for the page and the network.
const source = readFileSync(join(import.meta.dirname, '../../sandbox/libs/data.js'), 'utf8')
const BASE = 'https://api.example/api/data/'

let sent: string[]
let answer: () => { status?: number; body?: unknown } | Error

const load = (meta: string | null = BASE) => {
  const document = { querySelector: (selector: string) => (selector === 'meta[name="app-generator-data"]' && meta ? { content: meta } : null) }
  const window: { data?: any } = {}
  const fetch = async (url: string) => {
    sent.push(url)
    const reply = answer()
    if (reply instanceof Error) throw reply
    const status = reply.status ?? 200
    return {
      ok: status < 300,
      status,
      json: async () => {
        if (reply.body === undefined) throw new SyntaxError('no JSON')
        return reply.body
      },
    }
  }
  runInNewContext(source, { document, window, fetch })
  return window.data
}
const failureOf = async (work: () => Promise<unknown>) => {
  try {
    await work()
  } catch (error) {
    const { message, status } = error as { message: string; status: number }
    return { message, status }
  }
  return expect.unreachable('the call should have failed')
}

beforeEach(() => {
  sent = []
  answer = () => ({ body: {} })
})

describe('lib/data.js', () => {
  it('asks the four questions the server knows, with tidy parameters', async () => {
    const data = load()
    expect(data.available).toBe(true)
    answer = () => ({ body: { current: { temperature: 5 } } })
    expect(await data.weather(48.398412, '9.991554')).toEqual({ current: { temperature: 5 } })
    answer = () => ({ body: { places: [{ name: 'Ulm' }], credit: 'x' } })
    expect(await data.places('  Sankt Pölten & more ')).toEqual([{ name: 'Ulm' }])
    answer = () => ({ body: { base: 'EUR', rates: {} } })
    await data.rates('eur')
    await data.rateHistory('EUR', 'usd', 90.4)
    await data.rateHistory('EUR', 'USD')
    await data.rateHistory('EUR', 'USD', 5000)
    expect(sent).toEqual([
      `${BASE}weather?lat=48.40&lon=9.99`,
      `${BASE}places?name=Sankt%20P%C3%B6lten%20%26%20more`,
      `${BASE}rates?base=EUR`,
      `${BASE}history?base=EUR&symbol=USD&days=90`,
      `${BASE}history?base=EUR&symbol=USD&days=30`,
      `${BASE}history?base=EUR&symbol=USD&days=365`,
    ])
  })

  it('sends nothing for a position, a currency or a name that is none', async () => {
    const data = load()
    for (const [lat, lon] of [[91, 0], [0, 181], ['north', 0], [null, 0], [undefined, 0], ['', 0], [Number.NaN, 0], [48.4, '9.9&x=1']]) expect((await failureOf(() => data.weather(lat, lon))).message).toBe('Not a position on the map.')
    for (const code of ['EURO', 'E', '', 'EUR&x=1', '../', null, undefined, 12]) expect((await failureOf(() => data.rates(code))).message).toBe('Not a currency code.')
    expect((await failureOf(() => data.rateHistory('EUR', 'US$', 30))).message).toBe('Not a currency code.')
    for (const name of ['', ' a ', null, undefined, 7]) expect((await failureOf(() => data.places(name))).message).toBe('Type at least two letters of a place name.')
    expect(sent).toEqual([])
  })

  it('passes the server\'s sentence on when it refuses, and has one of its own when nothing can be read', async () => {
    const data = load()
    answer = () => ({ status: 429, body: { error: 'You have reached the limit for live data today. It works again tomorrow.' } })
    expect(await failureOf(() => data.rates('EUR'))).toEqual({ message: 'You have reached the limit for live data today. It works again tomorrow.', status: 429 })
    answer = () => ({ status: 502 })
    expect(await failureOf(() => data.rates('EUR'))).toEqual({ message: 'Live data is not available right now.', status: 502 })
    answer = () => ({ status: 200 })
    expect((await failureOf(() => data.rates('EUR'))).message).toBe('Live data is not available right now.')
    answer = () => new TypeError('Failed to fetch')
    expect(await failureOf(() => data.weather(1, 2))).toEqual({ message: 'Live data could not be reached.', status: 0 })
  })

  it('says so when the page was given no live data', async () => {
    const data = load(null)
    expect(data.available).toBe(false)
    expect((await failureOf(() => data.weather(1, 2))).message).toBe('This app has no live data.')
    expect(sent).toEqual([])
  })

  it('puts a weather code into words', () => {
    const data = load()
    expect(data.describe(0)).toEqual({ label: 'Clear sky', icon: '☀️' })
    expect(data.describe(61)).toEqual({ label: 'Light rain', icon: '🌦️' })
    expect(data.describe('95').label).toBe('Thunderstorm')
    for (const code of [4, -1, 'toString', '__proto__', null, undefined]) expect(data.describe(code)).toEqual({ label: 'Unknown', icon: '' })
  })
})
