/*
 * data.js: live data for an app made with App Generator.
 *
 *   const places = await data.places('Ulm')
 *   const weather = await data.weather(places[0].latitude, places[0].longitude)
 *   const latest = await data.rates('EUR')
 *   const series = await data.rateHistory('EUR', 'USD', 90)
 *
 * The app does not reach the sources itself. It asks App Generator's server,
 * which knows these four questions and nothing else. Where that server is, the
 * page is told when it is published, in a meta tag, and its policy lets it send
 * requests there and nowhere else.
 */
;(function () {
  'use strict'

  var base = null
  try {
    base = document.querySelector('meta[name="app-generator-data"]').content
  } catch (error) {
    // No live data for this page. Every call says so.
  }

  // World Meteorological Organization weather codes, as the forecast uses them.
  var WEATHER = {
    0: ['Clear sky', '☀️'],
    1: ['Mainly clear', '🌤️'],
    2: ['Partly cloudy', '⛅'],
    3: ['Overcast', '☁️'],
    45: ['Fog', '🌫️'],
    48: ['Freezing fog', '🌫️'],
    51: ['Light drizzle', '🌦️'],
    53: ['Drizzle', '🌦️'],
    55: ['Heavy drizzle', '🌧️'],
    56: ['Light freezing drizzle', '🌧️'],
    57: ['Freezing drizzle', '🌧️'],
    61: ['Light rain', '🌦️'],
    63: ['Rain', '🌧️'],
    65: ['Heavy rain', '🌧️'],
    66: ['Light freezing rain', '🌧️'],
    67: ['Freezing rain', '🌧️'],
    71: ['Light snow', '🌨️'],
    73: ['Snow', '🌨️'],
    75: ['Heavy snow', '❄️'],
    77: ['Snow grains', '🌨️'],
    80: ['Light showers', '🌦️'],
    81: ['Showers', '🌧️'],
    82: ['Heavy showers', '⛈️'],
    85: ['Light snow showers', '🌨️'],
    86: ['Snow showers', '❄️'],
    95: ['Thunderstorm', '⛈️'],
    96: ['Thunderstorm with hail', '⛈️'],
    99: ['Thunderstorm with heavy hail', '⛈️'],
  }

  function failure(message, status) {
    var error = new Error(message)
    error.status = status || 0
    return error
  }

  async function ask(question, params) {
    if (!base) throw failure('This app has no live data.')
    var query = Object.keys(params)
      .map(function (name) {
        return name + '=' + encodeURIComponent(params[name])
      })
      .join('&')
    var response
    try {
      response = await fetch(base + question + '?' + query)
    } catch (error) {
      throw failure('Live data could not be reached.')
    }
    var body = null
    try {
      body = await response.json()
    } catch (error) {
      // Not JSON: treated as no answer.
    }
    // The server's refusals are fixed sentences, fit to be shown.
    if (!response.ok) throw failure(body && typeof body.error === 'string' ? body.error : 'Live data is not available right now.', response.status)
    if (!body) throw failure('Live data is not available right now.', response.status)
    return body
  }

  function position(value, limit) {
    var number = Number(value)
    if (value === null || value === '' || !Number.isFinite(number) || Math.abs(number) > limit) throw failure('Not a position on the map.')
    return number.toFixed(2)
  }

  function code(value) {
    var name = String(value).toUpperCase()
    if (!/^[A-Z]{3}$/.test(name)) throw failure('Not a currency code.')
    return name
  }

  window.data = {
    available: Boolean(base),

    // The weather at a position: { current, hourly (24 hours), daily (7 days), timezone, units, credit }.
    weather: async function (latitude, longitude) {
      return ask('weather', { lat: position(latitude, 90), lon: position(longitude, 180) })
    },

    // Places with that name, best match first: [{ name, region, country, latitude, longitude }].
    places: async function (name) {
      if (typeof name !== 'string' || name.trim().length < 2) throw failure('Type at least two letters of a place name.')
      return (await ask('places', { name: name.trim().slice(0, 60) })).places
    },

    // Today's exchange rates of one currency: { base, date, rates: { USD: 1.08, ... }, credit }.
    rates: async function (base) {
      return ask('rates', { base: code(base) })
    },

    // One rate over the last 7 to 365 days: { base, symbol, points: [{ date, rate }], credit }.
    rateHistory: async function (base, symbol, days) {
      var span = Math.min(Math.max(Math.round(Number(days)) || 30, 7), 365)
      return ask('history', { base: code(base), symbol: code(symbol), days: span })
    },

    // A weather code in words and as a symbol: { label: 'Light rain', icon: '🌦️' }.
    describe: function (weatherCode) {
      var known = Object.prototype.hasOwnProperty.call(WEATHER, weatherCode) ? WEATHER[weatherCode] : ['Unknown', '']
      return { label: known[0], icon: known[1] }
    },
  }
})()
