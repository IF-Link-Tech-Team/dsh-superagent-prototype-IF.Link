/** Full-text search over the Store's FTS5 index, its rebuild from older databases, and the main Session's search tool. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SCHEMA_VERSION, Store } from '../src/app/store.ts'
import type { Decision, Ticket, Trigger } from '../src/core/index.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-search-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
const open = (name = 'orchestrator.sqlite') => new Store(join(directory, name))

const trigger = (id: string, text: string, at = '2026-09-01T00:00:00.000Z'): Trigger =>
  ({ id, source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_1' }], actor: { source: 'feishu', id: 'u' }, human: true, at, text, meta: {} })
const ticket = (id: string, title: string, summary?: string, at = '2026-09-02T00:00:00.000Z'): Ticket => ({
  id, title, decisionId: '', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'x', id: '' }, scope: '' },
  channels: [], assignments: summary === undefined
    ? [{ id: `${id}-a`, state: 'running', createdAt: '' }]
    : [{ id: `${id}-a`, state: 'ended', createdAt: '', report: { state: 'ready', summary, at: '' } }],
  inputs: [], undelivered: [], createdAt: at, updatedAt: at, origin: { triggerId: '', triggerIds: [] } })
const decision = (id: string, reason: Decision['reason'], at = '2026-09-03T00:00:00.000Z'): Decision =>
  ({ id, evalId: '', threadKey: 'feishu:oc_1:om_1', triggerIds: [], policyVersion: '', at, kind: 'ignore', reason, strength: 'explicit' })

it('indexes journal files on disk, serves them as a kind, and reindexes only when they change', () => {
  const store = open()
  const memory = join(directory, 'memory')
  mkdirSync(join(memory, 'journal'), { recursive: true })
  writeFileSync(join(memory, 'journal', '2026-10-05_10-11.md'), '# 2026-10-05 ~ 10-11\n\n## 项目｜第二课堂\n- 10-06 项目制试点排期定了\n')
  store.indexJournal(memory)
  const [match] = store.search('项目制', { kinds: ['journal'] })
  expect(match).toMatchObject({ kind: 'journal', ref: '2026-10-05_10-11.md' })
  expect(match!.snippet).toContain('项目制')
  // 文件变了才重建：改写内容后同一个实例再同步，搜得到新内容。
  writeFileSync(join(memory, 'journal', '2026-10-05_10-11.md'), '# 2026-10-05 ~ 10-11\n- 10-09 改成了另一件事\n')
  store.indexJournal(memory)
  expect(store.search('另一件事', { kinds: ['journal'] })).toHaveLength(1)
  // 三张表的行数比对不受 journal 影响，重建后也不会把 journal 弄丢。
  expect(store.search('项目制', { kinds: ['journal'] })).toHaveLength(0)
  store.close()
})

it('finds a Chinese substring with the trigram index, which marks the match in the snippet', () => {
  const store = open()
  store.triggers.save(trigger('t1', '第二课堂项目制试点进展顺利'))
  const [match] = store.search('项目制')
  expect(match).toMatchObject({ kind: 'trigger', ref: 't1', at: '2026-09-01T00:00:00.000Z' })
  expect(match!.snippet).toContain('[项目制]')
  store.close()
})

it('searches all three kinds, indexes a ticket by its title and latest report, and narrows to one kind', () => {
  const store = open()
  store.triggers.save(trigger('t1', '第二课堂项目制试点进展顺利'))
  store.tickets.save(ticket('k1', '项目制排期', '项目制试点进展'))
  store.decisions.save(decision('d1', [{ code: 'said', values: { text: '项目制试点' } }]))
  expect(store.search('项目制').map(match => `${match.kind}/${match.ref}`).sort()).toEqual(['decision/d1', 'ticket/k1', 'trigger/t1'])
  expect(store.search('项目制', { kinds: ['ticket'] }).map(match => match.ref)).toEqual(['k1'])
  expect(store.search('项目制', { kinds: ['trigger', 'decision'] }).map(match => match.ref).sort()).toEqual(['d1', 't1'])
  expect(store.search('项目制', { limit: 1 })).toHaveLength(1)
  // A ticket with no report is still found by its title.
  store.tickets.save(ticket('k2', 'Another task'))
  expect(store.search('Another').map(match => match.ref)).toEqual(['k2'])
  store.close()
})

it('replaces a record\'s indexed text when it is saved again', () => {
  const store = open()
  store.tickets.save(ticket('k1', '项目制排期'))
  store.tickets.save(ticket('k1', 'iflight 排期'))
  expect([store.search('项目制'), store.search('iflight').map(match => match.ref)]).toEqual([[], ['k1']])
  store.close()
})

it('falls back to a substring scan for a query under three characters', () => {
  const store = open()
  store.triggers.save(trigger('t1', '第二课堂项目制试点进展顺利'))
  expect(store.search('项目').map(match => match.ref)).toEqual(['t1'])
  expect(store.search('堂')[0]?.snippet).toContain('堂')
  expect(store.search('  项目  ').map(match => match.ref)).toEqual(['t1'])
  store.close()
})

it('returns nothing for an empty or blank query', () => {
  const store = open()
  store.triggers.save(trigger('t1', '第二课堂项目制试点进展顺利'))
  expect([store.search(''), store.search('   '), store.search('\n\t')]).toEqual([[], [], []])
  store.close()
})

it('treats punctuation in a query as text rather than FTS5 syntax', () => {
  const store = open()
  store.triggers.save(trigger('t1', 'fix "quotes" and *stars* and well-known: paths 50% a_b'))
  for (const query of ['"quotes"', '*stars*', 'well-known', 'well-known:', 'a:b', '50%', 'a_b', '"', '-', '*']) {
    expect(() => store.search(query), query).not.toThrow()
  }
  expect(store.search('"quotes"').map(match => match.ref)).toEqual(['t1'])
  expect(store.search('*stars*').map(match => match.ref)).toEqual(['t1'])
  expect(store.search('well-known:')[0]?.snippet).toContain('well-known')
  expect(store.search('50%').map(match => match.ref)).toEqual(['t1'])
  expect(store.search('a_b').map(match => match.ref)).toEqual(['t1'])
  store.close()
})

it('rebuilds the index on opening a database written before it existed', () => {
  const path = join(directory, 'orchestrator.sqlite')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL)')
  db.prepare('INSERT INTO kv VALUES (?,?)').run('schema', String(SCHEMA_VERSION))
  const saved = trigger('old', '第二课堂项目制试点进展顺利')
  db.prepare('INSERT INTO trigger VALUES (?,?,?)').run(saved.id, JSON.stringify(saved), saved.at)
  db.close()
  const store = new Store(path)
  expect(Number(store.db.prepare('SELECT count(*) AS count FROM search_fts').get()!.count)).toBe(1)
  expect(store.search('项目制').map(match => match.ref)).toEqual(['old'])
  store.close()
  // Opening it again finds the index complete, so the rebuild does not duplicate rows.
  const reopened = new Store(path)
  expect(Number(reopened.db.prepare('SELECT count(*) AS count FROM search_fts').get()!.count)).toBe(1)
  reopened.close()
})

it('registers the tool for the main Session only, with read paths orchestrator_read resolves', async () => {
  const h = await startRuntime()
  try {
    const { ticket, trigger } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
    expect(h.tools.get(h.runtime.masterId)!.has('orchestrator_search')).toBe(true)
    expect(h.tools.get(`worker-${ticket.id}`)!.has('orchestrator_search')).toBe(false)
    const { matches } = await h.runTool(h.runtime.masterId, 'orchestrator_search', { query: '回归', in: 'trigger' }) as
      { matches: { kind: string; ref: string; read: string; snippet: string }[] }
    expect(matches.map(match => match.read)).toEqual([`trigger/${trigger.id}`])
    expect(matches[0]!.snippet).toContain('回归')
    expect(await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: matches[0]!.read })).toMatchObject({ trigger_id: trigger.id })
  } finally { await h.stop() }
})
