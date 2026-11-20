import { beforeEach, describe, expect, it } from 'vitest'
import { showcaseCommand } from '../src/showcase.js'
import { Store } from '../src/store.js'

const DAY = 24 * 3_600_000
const APP = 'a'.repeat(20)
let store: Store
let said: string[]
const run = (...argv: string[]) => {
  said = []
  return showcaseCommand(store, argv, (text) => void said.push(text))
}

beforeEach(() => {
  store = new Store(':memory:')
  store.createJob({ id: APP, prompt: 'a kanban board', ipHash: 'h', screenMs: 900, expiresAt: Date.now() + DAY })
  store.setUsage(APP, { requests: 3, input: 10, output: 6_000, cacheRead: 40_000, cacheWrite: 7_000, costMicroUsd: 95_000 })
  store.setStatus(APP, 'done', { url: `https://apps.example/apps/${APP}/` })
})

describe('the showcase command', () => {
  it('pins, lists and unpins an app', () => {
    expect(run('list')).toBe(0)
    expect(said).toEqual(['No app is on the start page.'])
    expect(run('pin', APP, '--title', 'Team board', '--position', '2')).toBe(0)
    expect(said[0]).toMatch(new RegExp(`^2  ${APP}  Team board  \\d+ s  \\$0\\.10  pinned \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\dZ$`))
    expect(run('list')).toBe(0)
    expect(said[0]).toContain('Team board')
    expect(run('unpin', APP)).toBe(0)
    expect(said[0]).toMatch(/is off the start page/)
    expect(run('unpin', APP)).toBe(0)
    expect(said[0]).toMatch(/was not on the start page/)
  })

  it('says why an app cannot be pinned', () => {
    expect(run('pin', 'b'.repeat(20), '--title', 'Nothing')).toBe(1)
    expect(said).toEqual(['There is no live app with this id.'])
  })

  it('knows its own words and nothing else', () => {
    for (const argv of [[], ['pin', APP], ['pin', 'not-an-app', '--title', 'x'], ['pin', APP, '--title', 'x', '--position', 'first'], ['pin', APP, '--title', 'x', '--position', '0'], ['unpin'], ['list', APP], ['drop', APP], ['pin', APP, '--title', 'x', '--force']]) {
      expect(run(...argv)).toBe(2)
      expect(said[0]).toMatch(/^usage:/)
    }
    expect(store.showcase()).toEqual([])
  })
})
