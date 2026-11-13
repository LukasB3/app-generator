// What the browser check answers instead of the internet. The page under test
// is served from the files it was handed, at the address it will be published
// at. The two servers an app may talk to are stood in for: its tables start
// empty, which is what a freshly published app really shows, and the weather
// and exchange rates are made up but shaped exactly like the real answers.
// Everything else fails, as it would behind the page's policy.

const TYPES = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json', txt: 'text/plain; charset=utf-8', woff2: 'font/woff2', png: 'image/png' }
const DAY_MS = 86_400_000

const json = (status, body, headers = {}) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify(body) })

// Answers of another origin need the page's permission slip, preflight included.
const crossOrigin = (config, request, answer) => {
  const allow = {
    'access-control-allow-origin': new URL(config.base).origin,
    'access-control-expose-headers': 'content-range',
    vary: 'origin',
  }
  if (request.method === 'OPTIONS')
    return {
      status: 204,
      headers: { ...allow, 'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'access-control-allow-headers': request.headers['access-control-request-headers'] ?? '*', 'access-control-max-age': '600' },
      body: '',
    }
  const { status, headers, body } = answer()
  return { status, headers: { ...headers, ...allow }, body }
}

const file = (config, url) => {
  let path
  try {
    path = decodeURIComponent(url.pathname.slice(new URL(config.base).pathname.length))
  } catch {
    return { status: 404, headers: {}, body: '', missing: '(unreadable address)' }
  }
  if (path === '' || path.endsWith('/')) path += 'index.html'
  const bytes = config.files.get(path)
  if (!bytes) return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'Not found', missing: path }
  return { status: 200, headers: { 'content-type': TYPES[path.split('.').pop().toLowerCase()] ?? 'application/octet-stream' }, body: bytes }
}

// The part of the database's Data API that lib/db.js uses.
const database = (config, state, request, url) => {
  const name = url.pathname.slice(new URL(`${config.database.url}/rest/v1/`).pathname.length)
  const table = name.startsWith(config.database.prefix) ? name.slice(config.database.prefix.length) : ''
  if (!config.database.tables.includes(table)) return json(404, { code: 'PGRST205', message: 'Could not find the table in the schema cache' })
  if (!state.tables.has(table)) state.tables.set(table, { rows: [], nextId: 1 })
  const store = state.tables.get(table)
  const query = url.searchParams
  const stamp = () => new Date(config.now + state.clock++ * 1000).toISOString()
  const one = () => {
    const id = Number((query.get('id') ?? '').replace(/^eq\./, ''))
    return store.rows.find((row) => row.id === id)
  }
  let values = {}
  if (request.method === 'POST' || request.method === 'PATCH') {
    try {
      values = JSON.parse(request.body ?? '')
    } catch {
      return json(400, { message: 'Empty or invalid json' })
    }
    if (typeof values !== 'object' || values === null || Array.isArray(values)) return json(400, { message: 'Empty or invalid json' })
    for (const fixed of ['id', 'created_at', 'updated_at']) delete values[fixed]
  }

  if (request.method === 'GET') {
    const total = store.rows.length
    if (query.get('select') === 'updated_at') {
      const latest = store.rows.reduce((newest, row) => (row.updated_at > newest ? row.updated_at : newest), '')
      return json(200, total ? [{ updated_at: latest }] : [], { 'content-range': total ? `0-0/${total}` : '*/0' })
    }
    const limit = Math.min(Math.max(Number(query.get('limit')) || 500, 1), 500)
    const rows = (query.get('order') === 'id.desc' ? [...store.rows].reverse() : store.rows).slice(0, limit)
    return json(200, rows, { 'content-range': rows.length ? `0-${rows.length - 1}/*` : '*/*' })
  }
  if (request.method === 'POST') {
    const now = stamp()
    const row = { id: store.nextId++, created_at: now, updated_at: now, ...values }
    store.rows.push(row)
    return json(201, [row])
  }
  if (request.method === 'PATCH') {
    const row = one()
    if (row) Object.assign(row, values, { updated_at: stamp() })
    return json(200, row ? [row] : [])
  }
  if (request.method === 'DELETE') {
    const row = one()
    if (row) store.rows.splice(store.rows.indexOf(row), 1)
    return { status: 204, headers: {}, body: '' }
  }
  return json(405, { message: 'Method not allowed' })
}

// Made-up rates against the euro, in the range of the real ones.
const EURO_BUYS = { AUD: 1.65, BRL: 6.1, CAD: 1.5, CHF: 0.94, CNY: 7.8, CZK: 25.2, DKK: 7.46, EUR: 1, GBP: 0.85, HKD: 8.5, HUF: 395, IDR: 17500, ILS: 4, INR: 92, ISK: 150, JPY: 162, KRW: 1500, MXN: 20.5, MYR: 4.8, NOK: 11.7, NZD: 1.8, PHP: 62, PLN: 4.3, RON: 4.98, SEK: 11.3, SGD: 1.45, THB: 38, TRY: 37, USD: 1.08, ZAR: 20 }
const WEATHER_CODES = [1, 2, 3, 61, 2, 0, 80]
const WEATHER_CREDIT = 'Weather data by Open-Meteo.com'
const RATES_CREDIT = 'Exchange rates: European Central Bank, via Frankfurter'
const round = (value, places = 1) => Math.round(value * 10 ** places) / 10 ** places
const day = (time) => new Date(time).toISOString().slice(0, 10)
const hour = (time) => `${new Date(time).toISOString().slice(0, 13)}:00`
const rate = (base, symbol) => EURO_BUYS[symbol] / EURO_BUYS[base]
const invalid = () => json(400, { error: 'These are not valid parameters for this live data.' })

// The four questions of the live data routes, answered in the shape orchestrator/src/data.ts gives them.
const liveData = (config, url) => {
  const question = url.pathname.slice(new URL(config.liveData).pathname.length)
  const query = url.searchParams
  const now = config.now

  if (question === 'weather') {
    const latitude = Number(query.get('lat'))
    const longitude = Number(query.get('lon'))
    if (!query.get('lat') || !query.get('lon') || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return invalid()
    const warmth = (at) => 12 + 5 * Math.sin(((new Date(at).getUTCHours() - 9) / 24) * 2 * Math.PI)
    return json(200, {
      latitude,
      longitude,
      timezone: 'Europe/Berlin',
      current: { time: hour(now), temperature: round(warmth(now)), feelsLike: round(warmth(now) - 1.5), humidity: 64, precipitation: 0, wind: 11.2, windDirection: 240, code: 2, isDay: true },
      hourly: Array.from({ length: 24 }, (_, index) => {
        const at = now + index * 3_600_000
        return { time: hour(at), temperature: round(warmth(at)), precipitationChance: (index * 7) % 60, code: WEATHER_CODES[Math.floor(index / 4) % WEATHER_CODES.length] }
      }),
      daily: Array.from({ length: 7 }, (_, index) => {
        const date = day(now + index * DAY_MS)
        return { date, code: WEATHER_CODES[index], min: 6 + (index % 3), max: 14 + ((index * 2) % 5), precipitation: index % 3 === 0 ? 1.4 : 0, precipitationChance: (index * 13) % 70, sunrise: `${date}T07:12`, sunset: `${date}T16:48` }
      }),
      units: { temperature: '°C', wind: 'km/h', precipitation: 'mm' },
      credit: WEATHER_CREDIT,
    })
  }
  if (question === 'places') {
    const name = (query.get('name') ?? '').trim()
    if (name.length < 2) return invalid()
    const place = name[0].toUpperCase() + name.slice(1)
    return json(200, {
      places: [
        { name: place, region: 'Baden-Württemberg', country: 'Germany', latitude: 48.4, longitude: 9.99 },
        { name: place, region: 'Minnesota', country: 'United States', latitude: 44.31, longitude: -94.46 },
      ],
      credit: WEATHER_CREDIT,
    })
  }
  if (question === 'rates') {
    const base = query.get('base') ?? ''
    if (!Object.hasOwn(EURO_BUYS, base)) return invalid()
    return json(200, {
      base,
      date: day(now),
      rates: Object.fromEntries(
        Object.keys(EURO_BUYS)
          .filter((code) => code !== base)
          .map((code) => [code, round(rate(base, code), 4)]),
      ),
      credit: RATES_CREDIT,
    })
  }
  if (question === 'history') {
    const base = query.get('base') ?? ''
    const symbol = query.get('symbol') ?? ''
    const days = Number(query.get('days'))
    if (!Object.hasOwn(EURO_BUYS, base) || !Object.hasOwn(EURO_BUYS, symbol) || base === symbol || !(days >= 7 && days <= 365)) return invalid()
    const points = []
    for (let back = days; back >= 0; back--) {
      const at = now - back * DAY_MS
      // The bank publishes no rate at the weekend.
      if ([0, 6].includes(new Date(at).getUTCDay())) continue
      points.push({ date: day(at), rate: round(rate(base, symbol) * (1 + 0.02 * Math.sin(back / 9)), 4) })
    }
    return json(200, { base, symbol, points, credit: RATES_CREDIT })
  }
  return json(404, { error: 'There is no such live data.' })
}

export const newState = () => ({ tables: new Map(), clock: 0 })

// config: { base, files: Map<path, Buffer>, database: { url, prefix, tables } | null, liveData: string | null, now }
// request: { method, url, headers (lower-case names), body }
// Returns { status, headers, body, missing? }, or null for an address that has no answer.
export const respond = (config, state, request) => {
  let url
  try {
    url = new URL(request.url)
  } catch {
    return null
  }
  if (url.href.startsWith(config.base)) return file(config, url)
  if (config.database && url.href.startsWith(`${config.database.url}/rest/v1/`)) return crossOrigin(config, request, () => database(config, state, request, url))
  if (config.liveData && url.href.startsWith(config.liveData)) return crossOrigin(config, request, () => liveData(config, url))
  return null
}
