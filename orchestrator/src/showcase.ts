import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { loadConfig } from './config.js'
import { PinError, Store } from './store.js'

// The apps on the website's start page. There is no route for this on the
// internet: it runs on the server, as the service user, with orchestrator.env
// loaded, next to the running service.
//
//   node dist/showcase.js list
//   node dist/showcase.js pin <app id> --title "Team board" [--position 2]
//   node dist/showcase.js unpin <app id>
//
// A pinned app stays online with its files and tables until it is taken off,
// and cannot be changed meanwhile. Pinning it again brings its card up to date.

const APP_ID = /^[a-z2-7]{20}$/
const USAGE = 'usage: showcase.js list | pin <app id> --title "…" [--position n] | unpin <app id>'

const line = ({ position, appId, title, receipt, pinnedAt }: ReturnType<Store['showcase']>[number]) =>
  `${position}  ${appId}  ${title}  ${Math.round(receipt.seconds.total)} s  $${receipt.costUsd.toFixed(2)}  pinned ${new Date(pinnedAt).toISOString().slice(0, 16)}Z`

// Returns the exit code.
export const showcaseCommand = (store: Pick<Store, 'pin' | 'unpin' | 'showcase'>, argv: string[], log: (text: string) => void) => {
  let parsed
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { title: { type: 'string' }, position: { type: 'string' } } })
  } catch {
    log(USAGE)
    return 2
  }
  const { values, positionals } = parsed
  const [command, appId] = positionals
  if (command === 'list' && positionals.length === 1) {
    const pinned = store.showcase()
    log(pinned.length ? pinned.map(line).join('\n') : 'No app is on the start page.')
    return 0
  }
  if ((command === 'pin' || command === 'unpin') && positionals.length === 2 && APP_ID.test(appId ?? '')) {
    if (command === 'unpin') {
      log(store.unpin(appId!) ? `${appId} is off the start page. It goes when its time is up, within the hour if that has passed.` : `${appId} was not on the start page.`)
      return 0
    }
    const position = values.position === undefined ? undefined : Number(values.position)
    if (values.title === undefined || (position !== undefined && (!Number.isInteger(position) || position < 1 || position > 99))) {
      log(USAGE)
      return 2
    }
    try {
      log(line(store.pin({ appId: appId!, title: values.title, position })))
      return 0
    } catch (error) {
      if (!(error instanceof PinError)) throw error
      log(error.message)
      return 1
    }
  }
  log(USAGE)
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const store = new Store(join(loadConfig().DATA_DIR, 'jobs.sqlite'))
  try {
    process.exitCode = showcaseCommand(store, process.argv.slice(2), (text) => console.log(text))
  } finally {
    store.close()
  }
}
