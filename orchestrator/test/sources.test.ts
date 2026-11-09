import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeSourcesExcept, saveSources, seedWorkspace } from '../src/sources.js'

let dir: string
let cfg: { DATA_DIR: string }
let workspace: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ag-sources-'))
  cfg = { DATA_DIR: join(dir, 'data') }
  // A workspace as the pipeline prepares it: empty but for the bundled libraries.
  workspace = join(dir, 'workspace')
  mkdirSync(join(workspace, 'lib'), { recursive: true })
  writeFileSync(join(workspace, 'lib', 'qrcode.js'), '// lib')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const tree = (root: string) => (readdirSync(root, { recursive: true, withFileTypes: true }) as import('node:fs').Dirent[]).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1)).sort()

describe('stored sources', () => {
  it('gives a change the files of the last build, next to the libraries', async () => {
    await saveSources(cfg, 'app1', new Map([['index.html', '<p>one</p>'], ['js/app.js', 'let a = 1']]))
    expect(await seedWorkspace(cfg, 'app1', workspace)).toBe(true)
    expect(tree(workspace)).toEqual(['index.html', 'js/app.js', 'lib/qrcode.js'])
    expect(readFileSync(join(workspace, 'js/app.js'), 'utf8')).toBe('let a = 1')
  })

  it('replaces the stored files as a whole', async () => {
    await saveSources(cfg, 'app1', new Map([['index.html', '<p>one</p>'], ['old.js', '1']]))
    await saveSources(cfg, 'app1', new Map([['index.html', '<p>two</p>'], ['new.js', '2']]))
    await seedWorkspace(cfg, 'app1', workspace)
    expect(tree(workspace)).toEqual(['index.html', 'lib/qrcode.js', 'new.js'])
    expect(readFileSync(join(workspace, 'index.html'), 'utf8')).toBe('<p>two</p>')
  })

  it('has nothing for an app it never stored', async () => {
    expect(await seedWorkspace(cfg, 'unknown', workspace)).toBe(false)
    expect(tree(workspace)).toEqual(['lib/qrcode.js'])
  })

  it('removes the files of apps that are gone and keeps the rest', async () => {
    for (const id of ['keep1', 'gone1', 'gone2']) await saveSources(cfg, id, new Map([['index.html', id]]))
    // Half-written folders: one of a live app, one left behind by an app that is gone.
    mkdirSync(join(cfg.DATA_DIR, 'sources', 'keep1.new'))
    mkdirSync(join(cfg.DATA_DIR, 'sources', 'gone1.new'))
    await removeSourcesExcept(cfg, ['keep1', 'never-stored'])
    expect(readdirSync(join(cfg.DATA_DIR, 'sources')).sort()).toEqual(['keep1', 'keep1.new'])
    expect(existsSync(join(cfg.DATA_DIR, 'sources', 'keep1', 'index.html'))).toBe(true)

    await removeSourcesExcept({ DATA_DIR: join(dir, 'nothing-here') }, [])
  })
})
