import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Ticket, Trigger } from '../src/core/index.ts'
import { ALLOWED_RULES, draftEntries, endedEntries, heartbeatTrigger, memoryMtime, openEntries, scheduledTrigger,
  SchedulerConfigSchema, schedulerKind, tickScheduler, type SchedulerHost } from '../src/sources/scheduler.ts'
import { age, BEAT_POLICY, beatDue, buildChecklist, CHECKLIST_BUDGET, deadlineLines, dueDay, dueFollows, emptyChecklist,
  fireWindow, inActiveHours, instantOf, lastScheduledAt, nextFireAt, stampOf, wallClock, type Schedule } from '../src/sources/scheduler-job.ts'

const SHANGHAI = 'Asia/Shanghai'
/** 09:30 in Shanghai on 2026-11-13 (a Friday). */
const MORNING = Date.parse('2026-11-13T01:30:00Z')
const MINUTE = 60_000
const HOUR = 3_600_000

describe('wallClock', () => {
  it('reads an instant in the job\'s zone, not the host\'s', () => {
    expect(wallClock(MORNING, SHANGHAI)).toMatchObject({ year: 2026, month: 11, day: 13, hour: 9, minute: 30 })
  })

  it('reads the same instant differently in another zone', () => {
    expect(wallClock(MORNING, 'UTC')).toMatchObject({ hour: 1, minute: 30 })
  })
})

describe('nextFireAt', () => {
  it('keeps a daily job later today when its time has not passed', () => {
    const schedule: Schedule = { kind: 'daily', at: '09:30' }
    expect(nextFireAt(schedule, MORNING - 30 * MINUTE, SHANGHAI)).toBe(MORNING)
  })

  it('moves a daily job to tomorrow once its time has passed', () => {
    const schedule: Schedule = { kind: 'daily', at: '09:30' }
    expect(wallClock(nextFireAt(schedule, MORNING + MINUTE, SHANGHAI), SHANGHAI)).toMatchObject({ day: 14, hour: 9, minute: 30 })
  })

  it('lands a weekly job on its own weekday', () => {
    const schedule: Schedule = { kind: 'weekly', weekday: 1, at: '08:00' }
    const next = nextFireAt(schedule, MORNING, SHANGHAI)
    expect(wallClock(next, SHANGHAI)).toMatchObject({ weekday: 1, hour: 8, minute: 0 })
    expect(next).toBeGreaterThan(MORNING)
  })

  it('aligns an hourly job to epoch windows so a restart cannot shift it', () => {
    const schedule: Schedule = { kind: 'every', hours: 6 }
    const after = Date.parse('2026-11-13T05:10:00Z')
    const next = nextFireAt(schedule, after, SHANGHAI)
    expect(next).toBe(Date.parse('2026-11-13T06:00:00Z'))
    expect(nextFireAt(schedule, next, SHANGHAI)).toBe(next + 6 * HOUR)
  })
})

describe('fireWindow', () => {
  it('names a daily occurrence by its local date, so one day fires once', () => {
    expect(fireWindow({ kind: 'daily', at: '09:30' }, MORNING, SHANGHAI)).toBe('2026-11-13')
  })

  it('names an hourly occurrence by its window index', () => {
    expect(fireWindow({ kind: 'every', hours: 6 }, Date.parse('2026-11-13T06:00:00Z'), SHANGHAI)).toBe('83081')
  })
})

describe('stampOf', () => {
  it('separates the three inputs so a change in one is visible', () => {
    expect(stampOf({ lastEventAt: 1, draftsMtime: 2, memoryMtime: 3 })).not.toBe(stampOf({ lastEventAt: 1, draftsMtime: 2, memoryMtime: 4 }))
    expect(stampOf({})).toBe('0|0|0')
  })
})

describe('inActiveHours', () => {
  const hours = { start: '08:00', end: '23:00' }
  it.each([
    ['09:00', true], ['07:59', false], ['12:00', true], ['22:59', true], ['23:00', false], ['03:00', false],
  ])('%s falls inside %s', (time, inside) => {
    const [hour, minute] = time.split(':').map(Number) as [number, number]
    expect(inActiveHours({ year: 2026, month: 11, day: 13, hour, minute, weekday: 5 }, hours)).toBe(inside)
  })

  it('treats an overnight window as wrapping midnight', () => {
    const night = { start: '22:00', end: '06:00' }
    expect(inActiveHours({ year: 2026, month: 11, day: 13, hour: 2, minute: 0, weekday: 5 }, night)).toBe(true)
    expect(inActiveHours({ year: 2026, month: 11, day: 13, hour: 12, minute: 0, weekday: 5 }, night)).toBe(false)
  })
})

describe('beatDue', () => {
  const now = MORNING
  const beat = (overrides: Partial<Parameters<typeof beatDue>[0]>) => beatDue({ now, stamp: 'a', ...overrides })

  it('stays quiet inside the throttle window even when everything changed', () => {
    expect(beat({ lastBeat: now - 3 * HOUR, lastStamp: 'b', lastHumanAt: now - MINUTE })).toEqual({ beat: false })
  })

  it('calls once the silence limit passes, even with nothing new', () => {
    expect(beat({ lastBeat: now - 9 * HOUR, lastStamp: 'a' })).toEqual({ beat: true, reason: 'roll-call' })
  })

  it('treats the first look after a restart as its own reason, not as a change', () => {
    expect(beat({ lastBeat: now - 5 * HOUR, stamp: 'z' })).toEqual({ beat: true, reason: 'restart' })
  })

  it('waits when a stamp matches', () => {
    expect(beat({ lastBeat: now - 5 * HOUR, lastStamp: 'a' })).toEqual({ beat: false })
  })

  it('rides the cache when a change arrives while people are talking', () => {
    expect(beat({ lastBeat: now - 5 * HOUR, lastStamp: 'b', lastHumanAt: now - 2 * MINUTE })).toEqual({ beat: true, reason: 'on-activity' })
  })

  it('defers a change that has already gone cold to the next activity or the roll call', () => {
    expect(beat({ lastBeat: now - 5 * HOUR, lastStamp: 'b', lastHumanAt: now - 30 * MINUTE })).toEqual({ beat: false })
  })

  it('respects the active-hours window', () => {
    const activeHours = { start: '08:00', end: '23:00', timeZone: SHANGHAI }
    const night = Date.parse('2026-11-12T18:00:00Z')
    expect(beatDue({ now: night, stamp: 'a', lastBeat: night - 9 * HOUR, lastStamp: 'b', activeHours })).toEqual({ beat: false })
  })

  it('takes a policy so the thresholds are a decision, not a constant in the rule', () => {
    const policy = { ...BEAT_POLICY, throttleMs: 30 * MINUTE }
    expect(beat({ lastBeat: now - 45 * MINUTE, lastStamp: 'b', lastHumanAt: now - MINUTE, policy })).toEqual({ beat: true, reason: 'on-activity' })
  })
})

describe('buildChecklist', () => {
  const base = { now: MORNING, recentHours: 24, humanMessages: 42 }

  it('names what is open, what ended, what nobody decided, and whether memory moved', () => {
    const text = buildChecklist({ ...base,
      open: [{ name: '新生比赛推文', stage: 'person/review', stuckMs: 5 * HOUR }, { name: '词来计费', stage: 'working' }],
      ended: [{ name: '发文案', outcome: 'completed' }, { name: '回应呼叫', outcome: 'dropped' }],
      drafts: [{ name: '中期检查推迟到 11.28', unresolved: '手册何时改版没人认领' }],
      memoryAt: MORNING })
    expect(text).toContain('42 条人类消息')
    expect(text).toContain('新生比赛推文 [person/review] · 卡 5h')
    expect(text).toContain('最近 24h 结束 2（完成 1 / 无需处理 1）：发文案、回应呼叫')
    expect(text).toContain('手册何时改版没人认领')
    expect(text).toContain('orchestrator_read memory')
  })

  it('drops whole blocks rather than cutting a line, and says so', () => {
    const text = buildChecklist({ ...base, budget: 120,
      open: [{ name: '一个名字很长的工单标题占位', stage: 'working', stuckMs: HOUR }], ended: [],
      drafts: [{ name: '草稿甲', unresolved: '还没定' }, { name: '草稿乙', unresolved: '还没定' }] })
    expect(text.length).toBeLessThanOrEqual(120)
    expect(text).toContain('已截断')
  })

  it('says how many it left out when the list is capped', () => {
    const open = Array.from({ length: 7 }, (_, index) => ({ name: `工单${index}`, stage: 'working' }))
    const text = buildChecklist({ ...base, open, ended: [], drafts: [] })
    expect(text).toContain('## 在办 7')
    expect(text).toContain('…另 2 张')
  })

  it('stays within the default ceiling', () => {
    const open = Array.from({ length: 30 }, (_, index) => ({ name: `工单${index}`, stage: 'working', stuckMs: HOUR }))
    const drafts = Array.from({ length: 30 }, (_, index) => ({ name: `草稿${index}`, unresolved: '未决事项' }))
    expect(buildChecklist({ ...base, open, ended: [], drafts }).length).toBeLessThanOrEqual(CHECKLIST_BUDGET)
  })

  it('returns just the header when there is nothing to report', () => {
    expect(buildChecklist({ ...base, open: [], ended: [], drafts: [] })).toBe('# 心跳 上次以来 42 条人类消息')
  })
})

describe('emptyChecklist', () => {
  it('treats an idle system as nothing to say', () => {
    expect(emptyChecklist({ open: [], ended: [], drafts: [] })).toBe(true)
    expect(emptyChecklist({ open: [{ name: 'x', stage: 'working' }], ended: [], drafts: [] })).toBe(false)
  })
})

describe('age', () => {
  it.each([[30_000, '1m'], [5 * HOUR, '5h'], [26 * HOUR, '1d'], [Number.NaN, '?']])('%s reads as %s', (ms, text) => {
    expect(age(ms)).toBe(text)
  })
})

describe('instantOf', () => {
  it('round-trips a wall-clock time through the zone', () => {
    const at = instantOf({ year: 2026, month: 11, day: 13 }, 9, 30, SHANGHAI)
    expect(wallClock(at, SHANGHAI)).toMatchObject({ hour: 9, minute: 30, day: 13 })
  })
})

describe('lastScheduledAt', () => {
  it('names this morning when the window has passed today', () => {
    const schedule: Schedule = { kind: 'daily', at: '09:30' }
    expect(lastScheduledAt(schedule, MORNING + 30 * MINUTE, SHANGHAI)).toBe(MORNING)
  })

  it('names yesterday when the window has not come round yet', () => {
    const schedule: Schedule = { kind: 'daily', at: '09:30' }
    const before = MORNING - 30 * MINUTE
    const at = lastScheduledAt(schedule, before, SHANGHAI)
    expect(at).toBeDefined()
    expect(before - at!).toBeLessThan(2 * 24 * HOUR)
    expect(wallClock(at!, SHANGHAI)).toMatchObject({ hour: 9, minute: 30 })
  })

  it('names the most recent weekly occurrence within the past week', () => {
    const schedule: Schedule = { kind: 'weekly', weekday: 5, at: '09:30' }
    const at = lastScheduledAt(schedule, MORNING + MINUTE, SHANGHAI)
    expect(wallClock(at!, SHANGHAI)).toMatchObject({ weekday: 5, hour: 9, minute: 30 })
    expect(at).toBeLessThanOrEqual(MORNING + MINUTE)
  })

  it('names the current epoch window for an interval job', () => {
    const schedule: Schedule = { kind: 'every', hours: 6 }
    expect(lastScheduledAt(schedule, Date.parse('2026-11-13T05:10:00Z'), SHANGHAI)).toBe(Date.parse('2026-11-13T00:00:00Z'))
  })

  it('is what makes a missed window fire once rather than once per period', () => {
    const schedule: Schedule = { kind: 'daily', at: '09:30' }
    const threeDaysLater = MORNING + 3 * 24 * HOUR
    expect(fireWindow(schedule, lastScheduledAt(schedule, threeDaysLater, SHANGHAI)!, SHANGHAI)).toBe('2026-11-16')
  })
})

describe('scheduler kind', () => {
  it('observes its own events, which is what lets a senderless Trigger reach the assessment at all', () => {
    expect(schedulerKind.scope!({ meta: {} }, SchedulerConfigSchema.parse({}))).toEqual({ listened: true, observed: true, row: 'beat' })
  })

  it('offers the one admission row the panel needs, defaulting to ignored', () => {
    expect(schedulerKind.policy!.rows!({})).toMatchObject([{ id: 'beat' }])
  })

  it('builds a senderless Trigger confined to the periodic check, identified by its window', () => {
    const job = { id: 'daily-digest', title: '盘点', schedule: { kind: 'daily' as const, at: '09:30' }, text: '盘点在办工单', chatId: 'oc_1', enabled: true }
    const at = Date.parse('2026-11-13T01:30:00Z')
    const trigger = scheduledTrigger(job, at, '2026-11-13')
    expect(trigger).toMatchObject({ human: false, actor: { source: 'scheduler', id: '' }, threads: [{ source: 'scheduler', id: 'job:daily-digest' }] })
    expect(trigger.meta.allowRules).toEqual([...ALLOWED_RULES])
    expect(trigger.channel!.address).toEqual({ chatId: 'oc_1' })
    expect(scheduledTrigger(job, at, '2026-11-13').id).toBe(trigger.id)
    expect(scheduledTrigger(job, at, '2026-11-14').id).not.toBe(trigger.id)
  })

  it('refuses a job id the settings would not survive, and a time that does not exist', () => {
    expect(() => SchedulerConfigSchema.parse({ jobs: [{ id: 'A', title: 't', schedule: { kind: 'daily', at: '09:30' }, text: 'x' }] })).toThrow()
    expect(() => SchedulerConfigSchema.parse({ jobs: [{ id: 'a', title: 't', schedule: { kind: 'daily', at: '25:00' }, text: 'x' }] })).toThrow()
  })
})

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({ id: 't', title: 'x', decisionId: 'd',
  mandate: { strength: 'inferred', policyVersion: 'v', basis: { via: 'admission', cell: 'unlistedUnaddressed' },
    actor: { source: 'scheduler', id: '' }, scope: '' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '2026-11-13T00:00:00.000Z', updatedAt: '',
  origin: { triggerId: 'x', triggerIds: ['x'] }, ...overrides })
const execution = { name: '新生比赛推文-ade080e43b46', directory: 'dir', assignment: 'a' }

describe('openEntries', () => {
  it('names the stage and how long the ticket has waited since its last report', () => {
    const now = Date.parse('2026-11-13T09:30:00Z')
    const entries = openEntries([ticket({ execution, assignments: [{ id: 'a', state: 'running', createdAt: '',
      report: { state: 'ready', summary: '', at: '2026-11-13T04:30:00Z' } }] })], now)
    expect(entries).toEqual([{ name: '新生比赛推文', stage: 'person/review', stuckMs: 5 * HOUR }])
  })

  it('falls back to the title and creation time when nothing has been reported', () => {
    const now = Date.parse('2026-11-13T10:00:00Z')
    expect(openEntries([ticket({ createdAt: '2026-11-13T08:00:00.000Z' })], now)).toEqual([{ name: 'x', stage: 'working/queued', stuckMs: 2 * HOUR }])
  })
})

describe('endedEntries', () => {
  const ended = { at: '2026-11-13T08:00:00Z', by: 'executor' as const, reason: 'closed', outcome: 'merged' as const }

  it('reports what ended inside the window, with its outcome', () => {
    expect(endedEntries([ticket({ ended, execution })], Date.parse('2026-11-13T09:00:00Z'), 24)).toEqual([{ name: '新生比赛推文', outcome: 'merged' }])
  })

  it('drops what ended before the window and what never ended', () => {
    const later = Date.parse('2026-11-16T09:00:00Z')
    expect(endedEntries([ticket({ ended })], later, 24)).toEqual([])
    expect(endedEntries([ticket()], Date.parse('2026-11-13T09:00:00Z'), 24)).toEqual([])
  })
})

describe('draftEntries', () => {
  it('keeps only the unresolved part, with the ticket hash off the name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scheduler-'))
    mkdirSync(join(dir, 'drafts', 'inbox'), { recursive: true })
    writeFileSync(join(dir, 'drafts', 'inbox', '495c885b-中期检查.md'), '# 草稿\n\n## 没人认领\n- 别的\n\n## 没解决 / 要人定\n- 手册什么时候改版，没人认领\n')
    const { entries, mtime } = await draftEntries(dir, MORNING, SHANGHAI)
    expect(entries).toEqual([{ name: '中期检查', unresolved: '手册什么时候改版，没人认领' }])
    expect(mtime).toBeGreaterThan(0)
  })

  it('reads the follow-ups a draft promises, with the day each comes due', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scheduler-'))
    mkdirSync(join(dir, 'drafts', 'inbox'), { recursive: true })
    writeFileSync(join(dir, 'drafts', 'inbox', '495c885b-跟进.md'),
      '# 草稿\n\n## 要回来跟进\n- 2026-11-16 确认报名截止（等王怡然）\n- 没有日期的一条\n\n## 建议改动\n- 别的\n')
    const { follows } = await draftEntries(dir, MORNING, SHANGHAI)
    expect(follows).toEqual([{ due: '2026-11-16', what: '确认报名截止（等王怡然）' }])
  })

  it('treats a missing folder as no drafts rather than a failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scheduler-'))
    expect(await draftEntries(dir, MORNING, SHANGHAI)).toEqual({ entries: [], follows: [], mtime: undefined })
  })
})

describe('memoryMtime', () => {
  it('reports the newest memory file, and nothing when the folder has none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scheduler-'))
    expect(await memoryMtime(dir)).toBeUndefined()
    writeFileSync(join(dir, 'TEAM.md'), 'team')
    expect(await memoryMtime(dir)).toBeGreaterThan(0)
  })
})

describe('heartbeatTrigger', () => {
  it('lands on the one beat thread, senderless, confined to the periodic check', () => {
    const trigger = heartbeatTrigger('# 心跳', Date.parse('2026-11-13T09:30:00Z'), '2026-11-13T09:30', 'oc_1')
    expect(trigger).toMatchObject({ human: false, actor: { source: 'scheduler', id: '' },
      threads: [{ source: 'scheduler', id: 'beat' }], channel: { source: 'scheduler', thread: 'beat', address: { chatId: 'oc_1' } } })
    expect(trigger.meta).toMatchObject({ beat: true, allowRules: [...ALLOWED_RULES] })
    expect(heartbeatTrigger('# 心跳', Date.parse('2026-11-13T09:31:00Z'), '2026-11-13T09:31', 'oc_1').id).not.toBe(trigger.id)
  })
})

describe('tickScheduler with no configuration', () => {
  it('reports nothing and touches nothing, so a Source switched on later starts on the next tick', async () => {
    const received: Trigger[] = []
    const ctx: SchedulerHost = {
      config: () => undefined,
      receive: trigger => { received.push(trigger); return 'stored' },
      state: { get: () => undefined, set: () => {} },
      tickets: { open: () => [], list: () => [] },
      activity: () => ({}),
      configured: () => true,
      deployment: { memoryDir: '/nonexistent' },
    }
    expect(await tickScheduler(ctx, Date.now())).toEqual([])
    expect(received).toHaveLength(0)
  })
})

describe('dueDay', () => {
  it.each([
    ['2026-11-16 确认报名截止', '2026-11-16'],
    ['11-16 确认报名截止', '2026-11-16'],
    ['11月16日 确认报名截止', '2026-11-16'],
    ['没有提到日期', undefined],
  ])('reads %s as %s', (text, due) => {
    expect(dueDay(text, MORNING, SHANGHAI)).toBe(due)
  })
})

describe('dueFollows', () => {
  const items = [
    { due: '2026-11-20', what: '还没到' },
    { due: '2026-11-13', what: '今天' },
    { due: '2026-11-10', what: '过期了' },
  ]

  it('keeps what is due today or late, oldest first, and drops the future', () => {
    expect(dueFollows(items, MORNING, SHANGHAI)).toEqual([{ due: '2026-11-10', what: '过期了' }, { due: '2026-11-13', what: '今天' }])
  })
})

describe('deadlineLines', () => {
  const projects = ['## 项目：IF.Light', '- 待办：11-14 提交截止，手册仍写 11-14', '- 风险：场地还没定', '- 负责人：王怡然'].join('\n')

  it('keeps dated 待办 and 风险 lines inside the window, with the day in front', () => {
    expect(deadlineLines(projects, MORNING, SHANGHAI)).toEqual(['2026-11-14 待办：11-14 提交截止，手册仍写 11-14'])
  })

  it('drops a dated line that is already history', () => {
    expect(deadlineLines('- 待办：10-01 早就过去了', MORNING, SHANGHAI)).toEqual([])
  })

  it('ignores a past date quoted as evidence rather than declared as a due date', () => {
    // The real file cites dates like this; treating them as deadlines would resurrect old news every week.
    expect(deadlineLines('- 风险：硬件 150 元/队与 11-07「3000 元/14 队」对不上', MORNING, SHANGHAI)).toEqual([])
  })

  it('caps at three lines', () => {
    const many = Array.from({ length: 6 }, (_, i) => `- 待办：11-1${i % 4} 第 ${i} 件事`).join('\n')
    expect(deadlineLines(many, MORNING, SHANGHAI)).toHaveLength(3)
  })
})

describe('buildChecklist with follow-ups and deadlines', () => {
  it('puts what is due above the rest and keeps the pointer blocks last', () => {
    const text = buildChecklist({ now: MORNING, recentHours: 24, humanMessages: 3,
      open: [{ name: '工单甲', stage: 'working' }], ended: [], drafts: [],
      followUps: [{ due: '2026-11-13', what: '确认报名截止' }],
      deadlines: ['2026-11-14 待办：提交截止'], memoryAt: MORNING })
    expect(text.indexOf('## 要回来跟进')).toBeLessThan(text.indexOf('## 临近截止'))
    expect(text.indexOf('## 临近截止')).toBeLessThan(text.indexOf('## 记忆'))
    expect(text).toContain('- 2026-11-13 确认报名截止')
    expect(text).toContain('- 2026-11-14 待办：提交截止')
  })

  it('is not empty when only a follow-up came due', () => {
    expect(emptyChecklist({ open: [], ended: [], drafts: [], followUps: [{ due: '2026-11-13', what: 'x' }] })).toBe(false)
    expect(emptyChecklist({ open: [], ended: [], drafts: [], deadlines: ['2026-11-14 x'] })).toBe(false)
  })
})
