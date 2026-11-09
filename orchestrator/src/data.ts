import { z } from 'zod'

// Live data for published apps: the weather and exchange rates, from two
// public sources that need no key. An app cannot reach those sources itself.
// It asks this server, which knows a fixed set of questions with typed
// parameters, builds the upstream address on its own, follows no redirect,
// reads a bounded answer, and passes on only the fields it expects, each
// checked for its type. Nothing here is a pass-through.

// What a caller is told. The reason for a failed lookup stays in the log.
export class DataError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

const UNAVAILABLE = 'Live data is not available right now. Please try again later.'
const TIMEOUT_MS = 5_000
const MAX_ANSWER_BYTES = 200_000
const DAY_MS = 86_400_000

// The currencies the European Central Bank publishes reference rates for.
export const CURRENCIES = ['AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR'] as const
const WEATHER_CREDIT = 'Weather data by Open-Meteo.com'
const RATES_CREDIT = 'Exchange rates: European Central Bank, via Frankfurter'

// A plain decimal number within bounds, rounded to two places. For a position
// that is about a kilometre: close enough for the weather, coarse enough that
// neighbours share one answer and nobody's doorstep goes upstream.
const coordinate = (limit: number) =>
  z
    .string()
    .regex(/^-?\d{1,3}(\.\d{1,8})?$/)
    .transform((text) => Math.round(Number(text) * 100) / 100)
    .refine((value) => Math.abs(value) <= limit)
const currency = z.enum(CURRENCIES)
// The one free text among the parameters: the name of a place to look up.
const placeName = z
  .string()
  .transform((text) => text.normalize('NFC').trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(2).max(60).regex(/^[\p{L}\p{M}\d][\p{L}\p{M}\d .,'’-]*$/u))

// Thrown by the readers below when an answer is not what the source documents.
class Unexpected extends Error {}
const number = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Unexpected('not a number')
  return value
}
const numberOrNull = (value: unknown) => (value === null || value === undefined ? null : number(value))
const text = (value: unknown, max: number, pattern?: RegExp) => {
  if (typeof value !== 'string' || value.length > max || (pattern && !pattern.test(value))) throw new Unexpected('not the expected text')
  return value
}
const textOrEmpty = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '')
// Near the poles a day can pass without a sunrise.
const timeOrEmpty = (value: unknown) => (typeof value === 'string' && TIME.test(value) ? value : '')
const list = (value: unknown, max: number) => {
  if (!Array.isArray(value)) throw new Unexpected('not a list')
  return value.slice(0, max) as unknown[]
}
const record = (value: unknown) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Unexpected('not an object')
  return value as Record<string, unknown>
}
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
// Lists that belong together row by row, turned into one row per position.
const rows = <T>(columns: Record<string, unknown>, lead: string, max: number, row: (at: (name: string) => unknown) => T) =>
  list(columns[lead], max).map((_, index) => row((name) => list(columns[name], max)[index]))

interface Source<P> {
  params: z.ZodType<P>
  // How long an answer is good for.
  maxAgeS: number
  url(params: P, now: number): URL
  shape(raw: Record<string, unknown>, params: P): object
}
const source = <P>(definition: Source<P>) => definition as unknown as Source<unknown>

const SOURCES: Record<string, Source<unknown>> = {
  weather: source({
    params: z.object({ lat: coordinate(90), lon: coordinate(180) }),
    maxAgeS: 600,
    url: ({ lat, lon }) => {
      const url = new URL('https://api.open-meteo.com/v1/forecast')
      url.search = new URLSearchParams({
        latitude: String(lat),
        longitude: String(lon),
        current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,is_day',
        hourly: 'temperature_2m,precipitation_probability,weather_code',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset',
        forecast_days: '7',
        forecast_hours: '24',
        timezone: 'auto',
      }).toString()
      return url
    },
    shape: (raw) => {
      const current = record(raw.current)
      return {
        latitude: number(raw.latitude),
        longitude: number(raw.longitude),
        timezone: text(raw.timezone, 60),
        current: {
          time: text(current.time, 16, TIME),
          temperature: number(current.temperature_2m),
          feelsLike: number(current.apparent_temperature),
          humidity: number(current.relative_humidity_2m),
          precipitation: number(current.precipitation),
          wind: number(current.wind_speed_10m),
          windDirection: number(current.wind_direction_10m),
          code: number(current.weather_code),
          isDay: current.is_day === 1,
        },
        hourly: rows(record(raw.hourly), 'time', 24, (at) => ({
          time: text(at('time'), 16, TIME),
          temperature: numberOrNull(at('temperature_2m')),
          precipitationChance: numberOrNull(at('precipitation_probability')),
          code: numberOrNull(at('weather_code')),
        })),
        daily: rows(record(raw.daily), 'time', 7, (at) => ({
          date: text(at('time'), 10, DATE),
          code: numberOrNull(at('weather_code')),
          min: numberOrNull(at('temperature_2m_min')),
          max: numberOrNull(at('temperature_2m_max')),
          precipitation: numberOrNull(at('precipitation_sum')),
          precipitationChance: numberOrNull(at('precipitation_probability_max')),
          sunrise: timeOrEmpty(at('sunrise')),
          sunset: timeOrEmpty(at('sunset')),
        })),
        units: { temperature: '°C', wind: 'km/h', precipitation: 'mm' },
        credit: WEATHER_CREDIT,
      }
    },
  }),

  places: source({
    params: z.object({ name: placeName }),
    maxAgeS: 86_400,
    url: ({ name }) => {
      const url = new URL('https://geocoding-api.open-meteo.com/v1/search')
      url.search = new URLSearchParams({ name, count: '5', language: 'en', format: 'json' }).toString()
      return url
    },
    shape: (raw) => ({
      // A name nobody knows comes back without a list.
      places: (raw.results === undefined ? [] : list(raw.results, 5)).map((entry) => {
        const place = record(entry)
        return { name: text(place.name, 120), region: textOrEmpty(place.admin1, 120), country: textOrEmpty(place.country, 80), latitude: number(place.latitude), longitude: number(place.longitude) }
      }),
      credit: WEATHER_CREDIT,
    }),
  }),

  rates: source({
    params: z.object({ base: currency }),
    maxAgeS: 3_600,
    url: ({ base }) => new URL(`https://api.frankfurter.dev/v1/latest?base=${base}`),
    shape: (raw, { base }) => {
      const rates = record(raw.rates)
      return {
        base,
        date: text(raw.date, 10, DATE),
        rates: Object.fromEntries(CURRENCIES.filter((code) => code !== base && rates[code] !== undefined).map((code) => [code, number(rates[code])])),
        credit: RATES_CREDIT,
      }
    },
  }),

  history: source({
    params: z.object({ base: currency, symbol: currency, days: z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.number().min(7).max(365)) }).refine(({ base, symbol }) => base !== symbol),
    maxAgeS: 21_600,
    url: ({ base, symbol, days }, now) => new URL(`https://api.frankfurter.dev/v1/${new Date(now - days * DAY_MS).toISOString().slice(0, 10)}..?base=${base}&symbols=${symbol}`),
    shape: (raw, { base, symbol }) => ({
      base,
      symbol,
      points: Object.entries(record(raw.rates))
        .slice(0, 400)
        .map(([date, rates]) => ({ date: text(date, 10, DATE), rate: number(record(rates)[symbol]) })),
      credit: RATES_CREDIT,
    }),
  }),
}

export interface DataOptions {
  fetch?: typeof fetch
  now?: () => number
  log?: (line: string) => void
  // Lookups that go upstream per day, all together and for one visitor. Answers from memory are free.
  upstreamPerDay?: number
  upstreamPerVisitorPerDay?: number
  cacheEntries?: number
}

export interface Data {
  // `visitor` is whatever the caller counts visitors by; it is used for the daily limit only.
  get(name: string, query: unknown, visitor: string): Promise<{ body: object; maxAgeS: number }>
}

export const createData = ({ fetch: request = fetch, now = Date.now, log = console.error, upstreamPerDay = 5_000, upstreamPerVisitorPerDay = 300, cacheEntries = 500 }: DataOptions = {}): Data => {
  const cache = new Map<string, { until: number; body: object }>()
  // Lookups under way, so that many visitors asking the same thing at once cause one.
  const pending = new Map<string, Promise<object>>()
  let day = 0
  let used = 0
  const usedBy = new Map<string, number>()

  const lookUp = async (name: string, definition: Source<unknown>, params: unknown) => {
    const url = definition.url(params, now())
    try {
      const res = await request(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json', 'user-agent': 'app-generator (https://github.com/LukasB3/app-generator)' } })
      if (!res.ok) throw new Unexpected(`status ${res.status}`)
      const chunks: Uint8Array[] = []
      let size = 0
      for await (const chunk of res.body ?? []) {
        size += chunk.length
        if (size > MAX_ANSWER_BYTES) throw new Unexpected('answer too large')
        chunks.push(chunk)
      }
      return definition.shape(record(JSON.parse(Buffer.concat(chunks).toString('utf8'))), params)
    } catch (error) {
      // Never the address that was asked for: it holds what a visitor typed or where they are.
      log(`live data: ${name} at ${url.hostname} failed: ${error instanceof Error ? error.message : 'unknown'}`)
      throw new DataError(502, UNAVAILABLE)
    }
  }

  return {
    get: async (name, query, visitor) => {
      const definition = Object.hasOwn(SOURCES, name) ? SOURCES[name]! : undefined
      if (!definition) throw new DataError(404, 'There is no such live data.')
      const parsed = definition.params.safeParse(query)
      if (!parsed.success) throw new DataError(400, 'These are not valid parameters for this live data.')

      const key = `${name} ${JSON.stringify(parsed.data).toLowerCase()}`
      const kept = cache.get(key)
      if (kept && kept.until > now()) return { body: kept.body, maxAgeS: Math.max(1, Math.ceil((kept.until - now()) / 1000)) }

      let lookup = pending.get(key)
      if (!lookup) {
        const today = Math.floor(now() / DAY_MS)
        if (today !== day) {
          day = today
          used = 0
          usedBy.clear()
        }
        if (used >= upstreamPerDay) throw new DataError(503, 'Live data has reached its limit for today. It works again tomorrow.')
        if ((usedBy.get(visitor) ?? 0) >= upstreamPerVisitorPerDay) throw new DataError(429, 'You have reached the limit for live data today. It works again tomorrow.')
        used++
        usedBy.set(visitor, (usedBy.get(visitor) ?? 0) + 1)

        lookup = lookUp(name, definition, parsed.data).finally(() => pending.delete(key))
        pending.set(key, lookup)
        lookup.then(
          (body) => {
            cache.delete(key)
            cache.set(key, { until: now() + definition.maxAgeS * 1000, body })
            // The oldest answers make room.
            for (const oldest of cache.keys()) {
              if (cache.size <= cacheEntries) break
              cache.delete(oldest)
            }
          },
          () => {},
        )
      }
      return { body: await lookup, maxAgeS: definition.maxAgeS }
    },
  }
}
