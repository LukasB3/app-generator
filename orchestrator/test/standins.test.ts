import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { beforeEach, describe, expect, it } from 'vitest'
import { newState, respond, type StandInConfig, type StandInState } from '../../render/standins.mjs'
import { createData } from '../src/data.js'

// What the browser check answers in place of the internet. The two bundled
// libraries that talk to a server run here against it, unchanged, so that a
// page behaves in the check as it will once it is published.
const lib = (name: string) => readFileSync(join(import.meta.dirname, '../../sandbox/libs', name), 'utf8')
const BASE = 'https://apps.example/apps/app1/'
const DATABASE = { url: 'https://project.example', key: 'public-key', prefix: 'aapp1_' }
const LIVE = 'https://api.example/api/data/'
const NOW = Date.UTC(2026, 10, 13, 12)

let config: StandInConfig
let state: StandInState
const ask = (url: string, method = 'GET', headers: Record<string, string> = {}, body?: string) => respond(config, state, { method, url, headers, body })
// A browser's fetch, as far as the two libraries use it.
const pageFetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]))
  const answer = ask(url, init.method ?? 'GET', headers, init.body)
  if (!answer) throw new TypeError('Failed to fetch')
  const text = answer.body.toString()
  return { ok: answer.status < 300, status: answer.status, text: async () => text, json: async () => JSON.parse(text), headers: { get: (name: string) => answer.headers[name.toLowerCase()] ?? null } }
}
const page = (metas: Record<string, string>) => ({
  hidden: false,
  querySelector: (selector: string) => {
    const name = /^meta\[name="(.+)"\]$/.exec(selector)?.[1]
    return name && metas[name] ? { content: metas[name] } : null
  },
  addEventListener: () => {},
  removeEventListener: () => {},
})
const database = () => {
  const window: { db?: any } = {}
  runInNewContext(lib('db.js'), { document: page({ 'app-generator-db': JSON.stringify(DATABASE) }), window, fetch: pageFetch, setTimeout, clearTimeout })
  return window.db
}
const liveData = () => {
  const window: { data?: any } = {}
  runInNewContext(lib('data.js'), { document: page({ 'app-generator-data': LIVE }), window, fetch: pageFetch })
  return window.data
}
// The names and kinds of everything in an answer, without the values.
const shape = (value: unknown): unknown =>
  Array.isArray(value) ? [shape(value[0])] : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, inner]) => [key, shape(inner)])) : typeof value

beforeEach(() => {
  config = { base: BASE, files: new Map([['index.html', Buffer.from('<h1>Hello</h1>')], ['lib/chart.js', Buffer.from('chart')], ['preview.png', Buffer.from('png')]]), database: { url: DATABASE.url, prefix: DATABASE.prefix, tables: ['votes'] }, liveData: LIVE, now: NOW }
  state = newState()
})

describe('the app itself', () => {
  it('is served from its files, at the address it will be published at', () => {
    expect(ask(BASE)).toMatchObject({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    expect(ask(BASE)!.body.toString()).toBe('<h1>Hello</h1>')
    expect(ask(`${BASE}lib/chart.js?v=job1`)).toMatchObject({ status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' } })
    expect(ask(`${BASE}preview.png`)).toMatchObject({ status: 200, headers: { 'content-type': 'image/png' } })
  })

  it('answers 404 for a file the app does not have, and says which', () => {
    expect(ask(`${BASE}img/logo.png`)).toMatchObject({ status: 404, missing: 'img/logo.png' })
    expect(ask(`${BASE}%E0%A4%A`)).toMatchObject({ status: 404 })
  })

  it('has no answer for anything else on the internet', () => {
    expect(ask('https://apps.example/apps/app2/')).toBeNull()
    expect(ask('https://evil.example/collect?d=1')).toBeNull()
    expect(ask('https://project.example/auth/v1/user')).toBeNull()
    expect(ask('https://api.example/api/jobs')).toBeNull()
    expect(ask('not an address')).toBeNull()
  })

  it('has no database and no live data for an app that was given none', () => {
    config = { ...config, database: null, liveData: null }
    expect(ask(`${DATABASE.url}/rest/v1/aapp1_votes?select=*`)).toBeNull()
    expect(ask(`${LIVE}rates?base=EUR`)).toBeNull()
  })
})

describe('the tables of an app, as lib/db.js uses them', () => {
  it('start empty and keep what the page writes', async () => {
    const votes = database().table('votes')
    expect(await votes.list()).toEqual([])
    const first = await votes.insert({ choice: 'Rust', id: 99, created_at: 'never' })
    expect(first).toEqual({ id: 1, created_at: '2026-11-13T12:00:00.000Z', updated_at: '2026-11-13T12:00:00.000Z', choice: 'Rust' })
    await votes.insert({ choice: 'Go' })
    expect((await votes.list()).map((row: { choice: string }) => row.choice)).toEqual(['Rust', 'Go'])
    expect((await votes.list({ newestFirst: true, limit: 1 })).map((row: { choice: string }) => row.choice)).toEqual(['Go'])
    expect(await votes.update(1, { choice: 'Zig' })).toMatchObject({ id: 1, choice: 'Zig', created_at: first.created_at })
    expect((await votes.update(1, { choice: 'Zig' })).updated_at > first.updated_at).toBe(true)
    expect(await votes.update(7, { choice: 'C' })).toBeNull()
    await votes.remove(1)
    expect((await votes.list()).map((row: { id: number }) => row.id)).toEqual([2])
  })

  it('tell a listening page about its rows', async () => {
    const votes = database().table('votes')
    await votes.insert({ choice: 'Rust' })
    const rows = await new Promise((resolve) => votes.subscribe(resolve))
    expect(rows).toMatchObject([{ id: 1, choice: 'Rust' }])
  })

  it('answer the question a listening page asks: how many rows, and when the last was written', () => {
    const url = `${DATABASE.url}/rest/v1/aapp1_votes?select=updated_at&order=updated_at.desc&limit=1`
    expect(ask(url)).toMatchObject({ status: 200, body: '[]', headers: { 'content-range': '*/0' } })
    ask(`${DATABASE.url}/rest/v1/aapp1_votes`, 'POST', {}, '{"choice":"Rust"}')
    ask(`${DATABASE.url}/rest/v1/aapp1_votes`, 'POST', {}, '{"choice":"Go"}')
    expect(ask(url)).toMatchObject({ status: 200, body: '[{"updated_at":"2026-11-13T12:00:01.000Z"}]', headers: { 'content-range': '0-0/2' } })
  })

  it('know only the tables the app has or asked for', async () => {
    expect(await database().table('scores').list().catch((error: Error) => error.message)).toBe('This app has no such table.')
    expect(ask(`${DATABASE.url}/rest/v1/aapp2_votes?select=*`)).toMatchObject({ status: 404 })
  })

  it('let the page ask from its own address, as the real server does', () => {
    const preflight = ask(`${DATABASE.url}/rest/v1/aapp1_votes`, 'OPTIONS', { 'access-control-request-headers': 'apikey,content-profile,content-type,prefer' })
    expect(preflight).toMatchObject({ status: 204, headers: { 'access-control-allow-origin': 'https://apps.example', 'access-control-allow-headers': 'apikey,content-profile,content-type,prefer' } })
    expect(ask(`${DATABASE.url}/rest/v1/aapp1_votes?select=*`)!.headers).toMatchObject({ 'access-control-allow-origin': 'https://apps.example', 'access-control-expose-headers': 'content-range' })
  })
})

describe('live data, as lib/data.js uses it', () => {
  // The real routes, fed what the two sources answered on 2026-11-10.
  const forecast = {
    latitude: 48.39,
    longitude: 10.01,
    timezone: 'Europe/Berlin',
    current: { time: '2026-11-10T00:00', temperature_2m: 4.9, apparent_temperature: 2.7, relative_humidity_2m: 97, precipitation: 0, weather_code: 3, wind_speed_10m: 5.7, wind_direction_10m: 215, is_day: 0 },
    hourly: { time: ['2026-11-10T00:00'], temperature_2m: [4.9], precipitation_probability: [93], weather_code: [3] },
    daily: { time: ['2026-11-10'], weather_code: [61], temperature_2m_max: [9], temperature_2m_min: [4.1], precipitation_sum: [3.2], precipitation_probability_max: [100], sunrise: ['2026-11-10T07:21'], sunset: ['2026-11-10T16:44'] },
  }
  const search = { results: [{ name: 'Ulm', latitude: 48.39841, longitude: 9.99155, country: 'Germany', admin1: 'Baden-Wurttemberg' }] }
  const latest = { base: 'EUR', date: '2026-11-09', rates: { USD: 1.1215 } }
  const series = { base: 'EUR', rates: { '2026-10-20': { USD: 1.1215 } } }
  const real = createData({
    fetch: (async (url: URL) => new Response(JSON.stringify(url.hostname === 'api.open-meteo.com' ? forecast : url.hostname === 'geocoding-api.open-meteo.com' ? search : url.pathname.endsWith('/latest') ? latest : series))) as unknown as typeof fetch,
    now: () => NOW,
  })
  const really = async (name: string, query: object) => (await real.get(name, query, 'visitor')).body

  it('answers the four questions in the shape of the real routes', async () => {
    const data = liveData()
    expect(shape(await data.weather(48.4, 9.99))).toEqual(shape(await really('weather', { lat: '48.4', lon: '9.99' })))
    expect(shape(await data.places('ulm'))).toEqual(shape(((await really('places', { name: 'ulm' })) as { places: unknown }).places))
    expect(shape(await data.rateHistory('EUR', 'USD', 30))).toEqual(shape(await really('history', { base: 'EUR', symbol: 'USD', days: '30' })))
    const rates = await data.rates('EUR')
    expect(shape({ ...rates, rates: {} })).toEqual(shape({ ...(await really('rates', { base: 'EUR' })), rates: {} }))
    expect(Object.keys(rates.rates)).toHaveLength(29)
    expect(rates.rates.EUR).toBeUndefined()
    expect(Object.values(rates.rates).every((rate) => typeof rate === 'number' && rate > 0)).toBe(true)
  })

  it('gives a full day of hours and a full week, starting now', async () => {
    const weather = await liveData().weather(48.4, 9.99)
    expect(weather.hourly).toHaveLength(24)
    expect(weather.daily).toHaveLength(7)
    expect(weather.current.time).toBe('2026-11-13T12:00')
    expect(weather.daily[0].date).toBe('2026-11-13')
    expect(weather.daily[6].date).toBe('2026-11-19')
  })

  it('leaves weekends out of a history, as the bank does', async () => {
    const { points } = await liveData().rateHistory('EUR', 'USD', 30)
    expect(points.at(-1).date).toBe('2026-11-13')
    expect(points.some((point: { date: string }) => [0, 6].includes(new Date(point.date).getUTCDay()))).toBe(false)
    expect(points.length).toBeGreaterThan(18)
  })

  it('turns away what the real routes turn away', async () => {
    const data = liveData()
    expect(await data.rates('XXX').catch((error: Error) => error.message)).toBe('These are not valid parameters for this live data.')
    expect(await data.rateHistory('EUR', 'EUR', 30).catch((error: Error) => error.message)).toBe('These are not valid parameters for this live data.')
    expect(ask(`${LIVE}secrets`)).toMatchObject({ status: 404 })
  })
})
