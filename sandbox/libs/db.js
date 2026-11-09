/*
 * db.js: the shared database of an app made with App Generator.
 *
 *   const entries = db.table('entries')
 *   await entries.insert({ author: 'Ada', message: 'Hello' })
 *   const rows = await entries.list({ newestFirst: true })
 *   const stop = entries.subscribe((rows) => render(rows))
 *
 * Where the tables are is not written in the app. The page is told when it is
 * published, in a meta tag, and its policy lets it send requests there and
 * nowhere else. Everything in a table is public.
 */
;(function () {
  'use strict'

  var NAME = /^[a-z][a-z0-9_]{0,29}$/
  // How often an open page asks whether anything changed: quickly at first,
  // then less and less while nothing does. A hidden tab does not ask at all.
  var FIRST_MS = 2000
  var LAST_MS = 20000

  var config = null
  try {
    config = JSON.parse(document.querySelector('meta[name="app-generator-db"]').content)
  } catch (error) {
    // No database for this page. Every call says so.
  }

  function failure(message, status, detail) {
    var error = new Error(message)
    error.status = status || 0
    error.detail = detail || ''
    return error
  }

  // What went wrong, in words a visitor can be shown.
  function reason(status, detail) {
    if (detail === 'table is full') return 'This list is full. Nothing more can be added.'
    if (detail === 'row too large') return 'That is too long to be saved.'
    if (status === 401 || status === 403) return 'That is not allowed here.'
    if (status === 404) return 'This app has no such table.'
    return 'The database did not accept that.'
  }

  async function request(table, method, query, body, prefer) {
    if (!config) throw failure('This app has no database.')
    var headers = { apikey: config.key }
    headers[method === 'GET' ? 'Accept-Profile' : 'Content-Profile'] = 'apps'
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (prefer) headers.Prefer = prefer
    var response
    try {
      response = await fetch(config.url + '/rest/v1/' + config.prefix + table + (query ? '?' + query : ''), {
        method: method,
        headers: headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      })
    } catch (error) {
      throw failure('The database could not be reached.')
    }
    var text = await response.text()
    var data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch (error) {
      // Not JSON: treated as no content.
    }
    if (!response.ok) {
      var detail = data && typeof data.message === 'string' ? data.message : ''
      throw failure(reason(response.status, detail), response.status, detail)
    }
    return { data: data, range: response.headers.get('content-range') || '' }
  }

  function rowId(id) {
    var number = Number(id)
    if (!Number.isSafeInteger(number) || number < 1) throw failure('Not the id of a row.')
    return number
  }

  function plain(values) {
    if (typeof values !== 'object' || values === null || Array.isArray(values)) throw failure('A row is an object of column names and values.')
    return values
  }

  function table(name) {
    if (typeof name !== 'string' || !NAME.test(name)) throw failure('Not the name of a table.')
    // Pages that are listening, to be told at once about a change made from this page.
    var listeners = []
    function changed() {
      listeners.slice().forEach(function (wake) {
        wake()
      })
    }

    var self = {
      // All rows, oldest first. { newestFirst: true } turns the order around, { limit: 50 } shortens the list.
      list: async function (options) {
        var limit = Math.min(Math.max(Math.floor(Number(options && options.limit)) || 500, 1), 500)
        var result = await request(name, 'GET', 'select=*&order=id.' + (options && options.newestFirst ? 'desc' : 'asc') + '&limit=' + limit)
        return Array.isArray(result.data) ? result.data : []
      },

      // Adds a row and returns it as stored, with its id, created_at and updated_at.
      insert: async function (values) {
        var result = await request(name, 'POST', '', plain(values), 'return=representation')
        changed()
        return result.data && result.data[0]
      },

      // Changes columns of one row. Only in a table made with mode "shared".
      update: async function (id, values) {
        var result = await request(name, 'PATCH', 'id=eq.' + rowId(id), plain(values), 'return=representation')
        changed()
        return (result.data && result.data[0]) || null
      },

      // Deletes one row. Only in a table made with mode "shared".
      remove: async function (id) {
        await request(name, 'DELETE', 'id=eq.' + rowId(id))
        changed()
      },

      // Calls onRows with all rows now, and again whenever something in the
      // table changed, whoever changed it. Returns a function that stops it.
      subscribe: function (onRows, options) {
        var stopped = false
        var timer = null
        var delay = FIRST_MS
        var seen = null
        var busy = false

        async function check() {
          timer = null
          if (stopped || busy || document.hidden) return
          busy = true
          try {
            // A small question: how many rows are there, and when was the last one written?
            var latest = await request(name, 'GET', 'select=updated_at&order=updated_at.desc&limit=1', undefined, 'count=exact')
            var now = latest.range + '|' + (latest.data && latest.data[0] ? latest.data[0].updated_at : '')
            if (now === seen) {
              delay = Math.min(delay * 1.5, LAST_MS)
            } else {
              var rows = await self.list(options)
              seen = now
              delay = FIRST_MS
              if (!stopped) onRows(rows)
            }
          } catch (error) {
            delay = Math.min(delay * 2, LAST_MS)
          }
          busy = false
          if (!stopped && timer === null) timer = setTimeout(check, delay)
        }

        function wake() {
          if (stopped || document.hidden) return
          clearTimeout(timer)
          delay = FIRST_MS
          check()
        }

        listeners.push(wake)
        document.addEventListener('visibilitychange', wake)
        check()
        return function stop() {
          stopped = true
          clearTimeout(timer)
          document.removeEventListener('visibilitychange', wake)
          listeners = listeners.filter(function (each) {
            return each !== wake
          })
        }
      },
    }
    return self
  }

  window.db = { available: Boolean(config), table: table }
})()
