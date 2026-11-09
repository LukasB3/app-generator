import { beforeEach, describe, expect, it } from 'vitest'
import { DataError, createData, type Data } from '../src/data.js'

// The two sources as they answered on 2026-11-10, cut down to what matters here.
const forecast = {
  latitude: 48.39185,
  longitude: 10.006967,
  generationtime_ms: 0.7,
  timezone: 'Europe/Berlin',
  elevation: 485,
  current_units: { temperature_2m: '°C' },
  current: { time: '2026-11-10T00:00', interval: 900, temperature_2m: 4.9, apparent_temperature: 2.7, relative_humidity_2m: 97, precipitation: 0, weather_code: 3, wind_speed_10m: 5.7, wind_direction_10m: 215, is_day: 0 },
  hourly: { time: ['2026-11-10T00:00', '2026-11-10T01:00'], temperature_2m: [4.9, 5.1], precipitation_probability: [93, null], weather_code: [3, 61] },
  daily: { time: ['2026-11-10'], weather_code: [61], temperature_2m_max: [9], temperature_2m_min: [4.1], precipitation_sum: [3.2], precipitation_probability_max: [100], sunrise: ['2026-11-10T07:21'], sunset: ['2026-11-10T16:44'] },
}
const search = { results: [{ id: 2820256, name: 'Ulm', latitude: 48.39841, longitude: 9.99155, elevation: 480, country_code: 'DE', timezone: 'Europe/Berlin', population: 120451, country: 'Germany', admin1: 'Baden-Wurttemberg', admin2: 'Tübingen Region' }], generationtime_ms: 0.4 }
const latest = { amount: 1, base: 'EUR', date: '2026-11-09', rates: { USD: 1.1215, GBP: 0.8343, XXX: 5, ZAR: 20.1 } }
const series = { amount: 1, base: 'EUR', start_date: '2026-10-20', end_date: '2026-11-09', rates: { '2026-10-20': { USD: 1.1215 }, '2026-10-21': { USD: 1.1234 } } }

interface Call {
  url: URL
  init: RequestInit
}
let calls: Call[]
let upstream: (url: URL) => Response | Promise<Response>
let time: number
let logged: string[]
let data: Data
const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init)
const make = (options: Parameters<typeof createData>[0] = {}) =>
  createData({
    fetch: (async (url: URL, init: RequestInit) => {
      calls.push({ url, init })
      return upstream(url)
    }) as unknown as typeof fetch,
    now: () => time,
    log: (line) => logged.push(line),
    ...options,
  })
const refusal = async (name: string, query: unknown, visitor = 'visitor-1', from = data) => {
  try {
    await from.get(name, query, visitor)
  } catch (error) {
    if (error instanceof DataError) return `${error.status} ${error.message}`
    throw error
  }
  return 'answered'
}

beforeEach(() => {
  calls = []
  logged = []
  time = Date.UTC(2026, 10, 10, 12)
  upstream = (url) => json(url.hostname === 'api.open-meteo.com' ? forecast : url.hostname === 'geocoding-api.open-meteo.com' ? search : url.pathname.endsWith('/latest') ? latest : series)
  data = make()
})

describe('live data: what is asked upstream', () => {
  it('asks the weather service for a rounded position and nothing a caller could add', async () => {
    await data.get('weather', { lat: '48.398412', lon: '9.991554', hourly: 'everything', timezone: 'x' }, 'v')
    const { url, init } = calls[0]!
    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      latitude: '48.4',
      longitude: '9.99',
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,is_day',
      hourly: 'temperature_2m,precipitation_probability,weather_code',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset',
      forecast_days: '7',
      forecast_hours: '24',
      timezone: 'auto',
    })
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('asks for a place by name, the name encoded as data', async () => {
    await data.get('places', { name: '  Sankt   Pölten ' }, 'v')
    expect(calls[0]!.url.href).toBe('https://geocoding-api.open-meteo.com/v1/search?name=Sankt+P%C3%B6lten&count=5&language=en&format=json')
    await data.get('places', { name: "L'Aquila & x=1" }, 'v').catch(() => {})
    expect(calls).toHaveLength(1)
  })

  it('asks for rates of known currencies only, and for a history that starts the given number of days ago', async () => {
    await data.get('rates', { base: 'USD' }, 'v')
    expect(calls[0]!.url.href).toBe('https://api.frankfurter.dev/v1/latest?base=USD')
    await data.get('history', { base: 'EUR', symbol: 'USD', days: '30' }, 'v')
    expect(calls[1]!.url.href).toBe('https://api.frankfurter.dev/v1/2026-10-11..?base=EUR&symbols=USD')
  })

  it.each([
    ['weather', { lat: '91', lon: '0' }],
    ['weather', { lat: '48.4', lon: '181' }],
    ['weather', { lat: '48.4' }],
    ['weather', { lat: '1e1', lon: '0' }],
    ['weather', { lat: '0x10', lon: '0' }],
    ['weather', { lat: ' 48.4', lon: '9.9' }],
    ['weather', { lat: '48.4&current=x', lon: '9.9' }],
    ['weather', { lat: ['48.4', '1'], lon: '9.9' }],
    ['weather', { lat: 48.4, lon: 9.9 }],
    ['weather', null],
    ['places', { name: 'a' }],
    ['places', { name: 'x'.repeat(61) }],
    ['places', { name: 'Ulm?count=100' }],
    ['places', { name: 'https://evil.example/' }],
    ['places', { name: '<script>' }],
    ['places', {}],
    ['rates', { base: 'eur' }],
    ['rates', { base: 'XXX' }],
    ['rates', { base: 'EUR&symbols=USD' }],
    ['history', { base: 'EUR', symbol: 'EUR', days: '30' }],
    ['history', { base: 'EUR', symbol: 'USD', days: '6' }],
    ['history', { base: 'EUR', symbol: 'USD', days: '366' }],
    ['history', { base: 'EUR', symbol: 'USD', days: '30.5' }],
    ['history', { base: 'EUR', symbol: '../latest', days: '30' }],
  ])('refuses %s with %j before anything is sent', async (name, query) => {
    expect(await refusal(name, query)).toBe('400 These are not valid parameters for this live data.')
    expect(calls).toEqual([])
  })

  it('knows four questions and no others', async () => {
    for (const name of ['forecast', 'weather/../rates', '', 'constructor', '__proto__', 'https://evil.example']) expect(await refusal(name, {})).toBe('404 There is no such live data.')
    expect(calls).toEqual([])
  })
})

describe('live data: what is passed on', () => {
  it('hands on the weather in its own words, with nothing the source added', async () => {
    const { body, maxAgeS } = await data.get('weather', { lat: '48.4', lon: '9.99' }, 'v')
    expect(maxAgeS).toBe(600)
    expect(body).toEqual({
      latitude: 48.39185,
      longitude: 10.006967,
      timezone: 'Europe/Berlin',
      current: { time: '2026-11-10T00:00', temperature: 4.9, feelsLike: 2.7, humidity: 97, precipitation: 0, wind: 5.7, windDirection: 215, code: 3, isDay: false },
      hourly: [
        { time: '2026-11-10T00:00', temperature: 4.9, precipitationChance: 93, code: 3 },
        { time: '2026-11-10T01:00', temperature: 5.1, precipitationChance: null, code: 61 },
      ],
      daily: [{ date: '2026-11-10', code: 61, min: 4.1, max: 9, precipitation: 3.2, precipitationChance: 100, sunrise: '2026-11-10T07:21', sunset: '2026-11-10T16:44' }],
      units: { temperature: '°C', wind: 'km/h', precipitation: 'mm' },
      credit: 'Weather data by Open-Meteo.com',
    })
  })

  it('hands on places, rates and a history the same way', async () => {
    expect((await data.get('places', { name: 'Ulm' }, 'v')).body).toEqual({ places: [{ name: 'Ulm', region: 'Baden-Wurttemberg', country: 'Germany', latitude: 48.39841, longitude: 9.99155 }], credit: 'Weather data by Open-Meteo.com' })
    // A currency the list does not know is left out, whatever the source says.
    expect((await data.get('rates', { base: 'EUR' }, 'v')).body).toEqual({ base: 'EUR', date: '2026-11-09', rates: { GBP: 0.8343, USD: 1.1215, ZAR: 20.1 }, credit: 'Exchange rates: European Central Bank, via Frankfurter' })
    expect((await data.get('history', { base: 'EUR', symbol: 'USD', days: '30' }, 'v')).body).toEqual({
      base: 'EUR',
      symbol: 'USD',
      points: [
        { date: '2026-10-20', rate: 1.1215 },
        { date: '2026-10-21', rate: 1.1234 },
      ],
      credit: 'Exchange rates: European Central Bank, via Frankfurter',
    })
    upstream = () => json({ generationtime_ms: 0.2 })
    expect((await data.get('places', { name: 'Nowhereville' }, 'v')).body).toMatchObject({ places: [] })
  })

  it.each([
    ['text where a number belongs', { ...forecast, current: { ...forecast.current, temperature_2m: '<img src=x onerror=alert(1)>' } }],
    ['markup where a time belongs', { ...forecast, current: { ...forecast.current, time: '<b>now</b>' } }],
    ['a missing part', { ...forecast, daily: undefined }],
    ['a list instead of an object', [forecast]],
    ['not a number at all', { ...forecast, latitude: Number.NaN }],
  ])('passes on nothing when the answer holds %s', async (_name, answer) => {
    upstream = () => json(answer)
    expect(await refusal('weather', { lat: '48.4', lon: '9.99' })).toBe('502 Live data is not available right now. Please try again later.')
  })

  it('gives up on a redirect, an error, a slow or an oversized answer, and logs the host but never the question', async () => {
    const failures: [string, () => Response | Promise<Response>][] = [
      ['a redirect', () => Promise.reject(new TypeError('fetch failed: redirect mode is set to error'))],
      ['an error status', () => json({ error: true, reason: 'too many requests' }, { status: 429 })],
      ['a timeout', () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))],
      ['too much', () => new Response('x'.repeat(200_001))],
      ['no JSON', () => new Response('<html>maintenance</html>')],
    ]
    for (const [, answer] of failures) {
      upstream = answer
      expect(await refusal('places', { name: 'Musterstraße 12' })).toBe('502 Live data is not available right now. Please try again later.')
    }
    expect(logged).toHaveLength(failures.length)
    for (const line of logged) {
      expect(line).toMatch(/^live data: places at geocoding-api\.open-meteo\.com failed: /)
      expect(line).not.toMatch(/Musterstra/)
    }
  })
})

describe('live data: memory and limits', () => {
  it('answers the same question from memory until the answer is too old', async () => {
    await data.get('weather', { lat: '48.401', lon: '9.991' }, 'v')
    // A neighbour, a kilometre away at most, gets the same answer.
    const again = await data.get('weather', { lat: '48.4', lon: '9.99' }, 'someone-else')
    expect(calls).toHaveLength(1)
    time += 4 * 60_000
    expect((await data.get('weather', { lat: '48.4', lon: '9.99' }, 'v')).maxAgeS).toBe(360)
    expect(again.body).toMatchObject({ timezone: 'Europe/Berlin' })

    time += 6 * 60_000
    await data.get('weather', { lat: '48.4', lon: '9.99' }, 'v')
    expect(calls).toHaveLength(2)
    await data.get('places', { name: 'ULM' }, 'v')
    await data.get('places', { name: 'ulm' }, 'v')
    expect(calls).toHaveLength(3)
  })

  it('asks once when many ask at once', async () => {
    let release = () => {}
    upstream = () => new Promise<Response>((resolve) => (release = () => resolve(json(latest))))
    const all = Promise.all([1, 2, 3].map((n) => data.get('rates', { base: 'EUR' }, `v${n}`)))
    await new Promise((resolve) => setTimeout(resolve, 5))
    release()
    expect((await all).map(({ body }) => (body as { date: string }).date)).toEqual(['2026-11-09', '2026-11-09', '2026-11-09'])
    expect(calls).toHaveLength(1)
  })

  it('does not remember a failure', async () => {
    upstream = () => json({}, { status: 500 })
    expect(await refusal('rates', { base: 'EUR' })).toMatch(/^502/)
    upstream = () => json(latest)
    expect(await refusal('rates', { base: 'EUR' })).toBe('answered')
    expect(calls).toHaveLength(2)
  })

  it('keeps a bounded number of answers, the newest ones', async () => {
    data = make({ cacheEntries: 3 })
    for (const lat of ['1', '2', '3', '4']) await data.get('weather', { lat, lon: '0' }, 'v')
    await data.get('weather', { lat: '4', lon: '0' }, 'v')
    await data.get('weather', { lat: '2', lon: '0' }, 'v')
    expect(calls).toHaveLength(4)
    await data.get('weather', { lat: '1', lon: '0' }, 'v')
    expect(calls).toHaveLength(5)
  })

  it('gives one visitor a daily allowance of lookups, and everyone together another', async () => {
    data = make({ upstreamPerVisitorPerDay: 2, upstreamPerDay: 5 })
    const ask = (lat: number, visitor: string) => refusal('weather', { lat: String(lat), lon: '0' }, visitor)
    expect([await ask(1, 'a'), await ask(2, 'a')]).toEqual(['answered', 'answered'])
    expect(await ask(3, 'a')).toBe('429 You have reached the limit for live data today. It works again tomorrow.')
    // What is in memory costs nothing, for anyone.
    expect(await ask(1, 'a')).toBe('answered')
    expect([await ask(4, 'b'), await ask(5, 'b'), await ask(6, 'c')]).toEqual(['answered', 'answered', 'answered'])
    expect(await ask(7, 'd')).toBe('503 Live data has reached its limit for today. It works again tomorrow.')
    expect(calls).toHaveLength(5)

    time += 24 * 3_600_000
    expect([await ask(3, 'a'), await ask(7, 'd')]).toEqual(['answered', 'answered'])
  })

  it('counts a failed lookup against the allowance too', async () => {
    data = make({ upstreamPerVisitorPerDay: 2 })
    upstream = () => json({}, { status: 500 })
    expect([await refusal('rates', { base: 'EUR' }, 'a'), await refusal('rates', { base: 'USD' }, 'a')]).toEqual([expect.stringMatching(/^502/), expect.stringMatching(/^502/)])
    expect(await refusal('rates', { base: 'GBP' }, 'a')).toMatch(/^429/)
    expect(calls).toHaveLength(2)
  })
})
