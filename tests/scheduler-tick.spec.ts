import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Ticket, Trigger } from '../src/core/index.ts'
import { SchedulerConfigSchema, tickScheduler, type SchedulerHost } from '../src/sources/scheduler.ts'

const HOUR = 3_600_000
/** 10:00 in Shanghai; a daily job at 09:30 is therefore already due today. */
const NOW = Date.parse('2026-11-13T02:00:00Z')
const execution = { name: '新生比赛推文-ade080e43b46', directory: 'dir', assignment: 'a' }
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({ id: 't', title: 'x', decisionId: 'd',
  mandate: { strength: 'inferred', policyVersion: 'v', basis: { via: 'admission', cell: 'unlistedUnaddressed' },
    actor: { source: 'scheduler', id: '' }, scope: '' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '2026-11-13T00:00:00.000Z', updatedAt: '',
  origin: { triggerId: 'x', triggerIds: ['x'] }, ...overrides })

/** A Source context with only what a tick reads, plus the triggers it produced. */
function host(overrides: Partial<SchedulerHost> = {}, options: { config?: unknown; memoryDir?: string } = {}) {
  const received: Trigger[] = []
  const store = new Map<string, unknown>()
  const memoryDir = options.memoryDir ?? mkdtempSync(join(tmpdir(), 'scheduler-tick-'))
  const config = SchedulerConfigSchema.parse(options.config ?? {})
  const value: SchedulerHost = {
    config: <C extends Record<string, unknown>>() => config as unknown as C,
    receive: trigger => { received.push(trigger); return 'stored' },
    state: { get: <V,>(key: string) => store.get(key) as V | undefined,
      set: <V,>(key: string, item: V | undefined) => { if (item === undefined) store.delete(key); else store.set(key, item) } },
    tickets: { open: () => [], list: () => [] },
    activity: () => ({}),
    configured: () => true,
    deployment: { memoryDir },
    ...overrides,
  }
  return { ctx: value, received, store, memoryDir }
}

const daily = { id: 'daily-digest', title: '盘点', schedule: { kind: 'daily', at: '09:30' }, text: '盘点在办工单', chatId: 'oc_1', enabled: true }

describe('tickScheduler: jobs', () => {
  it('fires a due job once, and reports the next occurrence on later ticks', async () => {
    const h = host({}, { config: { jobs: [daily] } })
    expect(await tickScheduler(h.ctx, NOW)).toEqual(['daily-digest: 已触发 2026-11-13'])
    expect(h.received).toHaveLength(1)
    expect(h.received[0]!.id).toBe(h.received[0]!.id)
    expect(h.received[0]!.meta).toMatchObject({ jobId: 'daily-digest', window: '2026-11-13' })

    const again = await tickScheduler(h.ctx, NOW + 60_000)
    expect(again).toEqual(['daily-digest: 下次 11-14 09:30'])
    expect(h.received).toHaveLength(1)
  })

  it('does not fire before its time', async () => {
    const h = host({}, { config: { jobs: [{ ...daily, schedule: { kind: 'daily', at: '11:00' } }] } })
    expect(await tickScheduler(h.ctx, NOW)).toEqual(['daily-digest: 下次 11-13 11:00'])
    expect(h.received).toHaveLength(0)
  })

  it('skips a job with no chat to deliver to, and a job switched off', async () => {
    const h = host({}, { config: { jobs: [{ ...daily, chatId: '' }, { ...daily, id: 'off', enabled: false }] } })
    expect(await tickScheduler(h.ctx, NOW)).toEqual(['daily-digest: 未配置 chatId，跳过'])
    expect(h.received).toHaveLength(0)
  })

  it('does not report an occurrence it missed while the service was down', async () => {
    const h = host({}, { config: { jobs: [daily] } })
    // Seven hours after a 09:30 window: too old to be worth saying, so it waits for tomorrow and says when.
    const lines = await tickScheduler(h.ctx, NOW + 7 * HOUR)
    expect(lines).toEqual(['daily-digest: 下次 11-14 09:30'])
    expect(h.received).toHaveLength(0)
    // Left unmarked on purpose: the next occurrence is judged on its own.
    expect(h.store.has('scheduler-fired:daily-digest')).toBe(false)
  })

  it('leaves the window unmarked when the Engine refuses the trigger, so the next tick retries it', async () => {
    const h = host({ receive: () => { throw new Error('Orchestrator is stopping') } }, { config: { jobs: [daily] } })
    expect((await tickScheduler(h.ctx, NOW))[0]).toContain('触发失败')
    expect(h.store.has('scheduler-fired:daily-digest')).toBe(false)
  })
})

describe('tickScheduler: heartbeat', () => {
  const beat = { enabled: true, chatId: 'oc_1', activeHours: { start: '08:00', end: '23:00' } }

  it('stays quiet when there is nothing a person would act on, and calls no model', async () => {
    const h = host({}, { config: { heartbeat: beat } })
    expect(await tickScheduler(h.ctx, NOW)).toEqual(['心跳 roll-call: 无内容，未调用模型'])
    expect(h.received).toHaveLength(0)
    expect(h.store.get('scheduler-beat')).toMatchObject({ reason: 'roll-call:quiet' })
  })

  it('sends a card when an open ticket has been waiting', async () => {
    const h = host({ tickets: { open: () => [ticket({ execution, assignments: [{ id: 'a', state: 'running', createdAt: '',
      report: { state: 'ready', summary: '', at: '2026-11-13T01:00:00Z' } }] })], list: () => [] } }, { config: { heartbeat: beat } })
    expect(await tickScheduler(h.ctx, NOW)).toEqual(['心跳 roll-call'])
    expect(h.received).toHaveLength(1)
    const trigger = h.received[0]!
    expect(trigger.threads).toEqual([{ source: 'scheduler', id: 'beat' }])
    expect(trigger.human).toBe(false)
    expect(trigger.text).toContain('新生比赛推文 [person/review]')
    expect(trigger.text).toContain('卡 1h')
    expect(trigger.channel!.address).toEqual({ chatId: 'oc_1' })
  })

  it('throttles to one beat every four hours', async () => {
    const open = () => [ticket({ execution })]
    const h = host({ tickets: { open, list: () => [] } }, { config: { heartbeat: beat } })
    await tickScheduler(h.ctx, NOW)
    expect(h.received).toHaveLength(1)
    await tickScheduler(h.ctx, NOW + 2 * HOUR)
    expect(h.received).toHaveLength(1)
  })

  it('stays out of the night', async () => {
    const h = host({ tickets: { open: () => [ticket()], list: () => [] } }, { config: { heartbeat: beat } })
    // 02:00 in Shanghai: inside the 08:00–23:00 window's opposite.
    expect(await tickScheduler(h.ctx, Date.parse('2026-11-13T18:00:00Z'))).toEqual([])
    expect(h.received).toHaveLength(0)
  })

  it('does nothing while the heartbeat is off, whatever the state says', async () => {
    const h = host({ tickets: { open: () => [ticket()], list: () => [] } }, { config: { heartbeat: { ...beat, enabled: false } } })
    expect(await tickScheduler(h.ctx, NOW)).toEqual([])
    expect(h.received).toHaveLength(0)
  })

  it('tells the reader that the memory moved only when it moved since the last beat', async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), 'scheduler-memory-'))
    mkdirSync(join(memoryDir, 'drafts', 'inbox'), { recursive: true })
    writeFileSync(join(memoryDir, 'TEAM.md'), 'team')
    const h = host({ tickets: { open: () => [ticket()], list: () => [] } }, { config: { heartbeat: beat }, memoryDir })
    await tickScheduler(h.ctx, NOW)
    expect(h.received[0]!.text).toContain('记忆')
    // A later beat whose memory file changed before the previous beat must not claim an update.
    // Wall-clock independent: this test is about the memory line, so the night window is opened all day.
    const anytime = { ...beat, activeHours: { start: '00:00', end: '23:59' } }
    const later = host({ tickets: { open: () => [ticket()], list: () => [] } }, { config: { heartbeat: anytime }, memoryDir })
    // The file's mtime is real time, so the previous beat is placed after it rather than at the fake clock.
    const real = Date.now()
    later.store.set('scheduler-beat', { at: real + HOUR, stamp: 'stale', reason: 'roll-call', humanTriggers: 0 })
    expect(await tickScheduler(later.ctx, real + 10 * HOUR)).toEqual(['心跳 roll-call'])
    expect(later.received[0]!.text).not.toContain('记忆')
  })
})
