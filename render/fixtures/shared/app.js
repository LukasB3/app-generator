// Uses a table and live data the moment it loads. If either cannot be reached
// the way a published page reaches them, this ends in an error the check reports.
const list = document.getElementById('list')
const say = (text) => {
  const item = document.createElement('li')
  item.textContent = text
  list.append(item)
}
;(async () => {
  const entries = db.table('entries')
  await entries.insert({ author: 'Ada' })
  const rows = await entries.list()
  say(`${rows.length} entry, by ${rows[0].author}`)
  const [place] = await data.places('Ulm')
  const weather = await data.weather(place.latitude, place.longitude)
  say(`${place.name}: ${weather.current.temperature} ${weather.units.temperature}`)
})().catch((error) => console.error(error.message))
