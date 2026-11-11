import { describe, expect, it } from 'vitest'
import { agentSteps } from '../src/sandbox.js'

const assistant = (...content: unknown[]) => JSON.stringify({ type: 'assistant', message: { content } })
const tool = (name: string, input: unknown = {}) => ({ type: 'tool_use', id: 'toolu_1', name, input })

describe('reading the agent\'s stream', () => {
  it('names the files the agent writes, and hides paths that do not look like one', () => {
    expect(agentSteps(assistant(tool('Write', { file_path: '/workspace/index.html' }), tool('Edit', { file_path: 'js/app.js' }))).files).toEqual(['index.html', 'js/app.js'])
    expect(agentSteps(assistant(tool('Write', { file_path: '/workspace/../etc/passwd' }), tool('Write', { file_path: '<b>x</b>' }), tool('Write'))).files).toEqual(['(file)', '(file)', '(file)'])
    expect(agentSteps(assistant(tool('Read', { file_path: '/workspace/index.html' }))).files).toEqual([])
  })

  it('notices a wish for a table or a column, and nothing else the database tools do', () => {
    expect(agentSteps(assistant(tool('mcp__db__create_table', { table: 'entries' }))).askedDatabase).toBe(true)
    expect(agentSteps(assistant(tool('mcp__db__add_column', { table: 'entries', name: 'author', type: 'text' }))).askedDatabase).toBe(true)
    expect(agentSteps(assistant(tool('mcp__db__list_tables'))).askedDatabase).toBe(false)
    expect(agentSteps(assistant({ type: 'text', text: 'I will call mcp__db__create_table' })).askedDatabase).toBe(false)
  })

  it('tells how the run ended, and takes anything else for nothing', () => {
    expect(agentSteps(JSON.stringify({ type: 'result', subtype: 'success', is_error: false })).outcome).toBe('success')
    expect(agentSteps(JSON.stringify({ type: 'result', subtype: 'success', is_error: true })).outcome).toBe('error')
    expect(agentSteps(JSON.stringify({ type: 'result', subtype: 'error_max_turns' })).outcome).toBe('error')
    expect(agentSteps('not json')).toEqual({ files: [], askedDatabase: false })
    expect(agentSteps('null')).toEqual({ files: [], askedDatabase: false })
  })
})
