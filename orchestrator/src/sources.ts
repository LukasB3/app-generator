import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Config } from './config.js'

// An app's own files, as text and exactly as the checker read them, kept so
// that a later change can start from them. The published copies would not do:
// they carry what the checker added. Only apps with an owner have sources,
// and they are removed with the app.

type Where = Pick<Config, 'DATA_DIR'>
const root = (cfg: Where) => join(cfg.DATA_DIR, 'sources')

export const saveSources = async (cfg: Where, appId: string, sources: Map<string, string>) => {
  const dir = join(root(cfg), appId)
  const fresh = `${dir}.new`
  await rm(fresh, { recursive: true, force: true })
  for (const [path, text] of sources) {
    await mkdir(dirname(join(fresh, path)), { recursive: true })
    await writeFile(join(fresh, path), text)
  }
  // Swapped in whole, so a change never starts from half an app.
  await rm(dir, { recursive: true, force: true })
  await rename(fresh, dir)
}

// Copies the stored files into a workspace. Answers false if there are none.
export const seedWorkspace = async (cfg: Where, appId: string, workspace: string) => {
  const dir = join(root(cfg), appId)
  if (!existsSync(dir)) return false
  await cp(dir, workspace, { recursive: true })
  return true
}

export const removeSourcesExcept = async (cfg: Where, keepIds: Iterable<string>) => {
  const keep = new Set(keepIds)
  const names = await readdir(root(cfg)).catch(() => [])
  // A folder that is just being written (`.new`) belongs to its app.
  for (const name of names) if (!keep.has(name.replace(/\.new$/, ''))) await rm(join(root(cfg), name), { recursive: true, force: true })
}
