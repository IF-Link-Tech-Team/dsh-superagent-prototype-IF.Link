/**
 * Pure scheduling rules for the Scheduler Source: when a job is due, whether a heartbeat is worth one model call, and
 * the index card that call reads.
 *
 * Nothing here touches the Feishu API, the Store or a Session: the functions take values and return values, so every
 * rule below is testable without a running deployment, and a caller that forgets to pass a capability cannot use it.
 * See `docs/iflink/heartbeat-scheduler.md` sections 5.1b, 5.5 and 5.8 for the reasoning behind each rule.
 */
import { z } from 'zod'

/** The schedule shapes a job may use. Deliberately not full cron: three shapes cover every case we have, and a wrong field name fails at validation instead of silently never firing. */
export const ScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('09:30') }).strict(),
  z.object({ kind: z.literal('weekly'), weekday: z.number().int().min(1).max(7), at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }).strict(),
  z.object({ kind: z.literal('every'), hours: z.number().int().min(1).max(168) }).strict(),
])
export type Schedule = z.infer<typeof ScheduleSchema>

/** One configured job: what to say, when, where, and how it may act. */
export const JobSchema = z.object({
  id: z.string().trim().min(1).max(40).regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().trim().min(1).max(60),
  schedule: ScheduleSchema,
  /** The instruction the job hands the assessment, in the team's own words. */
  text: z.string().trim().min(1).max(1000),
  /** The chat a result is delivered to; empty until someone fills it in, and a job without one does not run. */
  chatId: z.string().trim().default(''),
  /** A job is tried out by leaving the rule it would need unwritten: no enabled rule means nothing can be accepted. */
  enabled: z.boolean().default(true),
}).strict()
export type Job = z.infer<typeof JobSchema>

/** A local wall-clock time in the job's zone, without seconds. */
export interface WallClock { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

/** Read one instant as wall-clock time in `timeZone`; the zone is explicit so a host in UTC cannot shift every job by hours in silence. */
export function wallClock(ms: number, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(new Date(ms))
  const value = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
  return { year: Number(value('year')), month: Number(value('month')), day: Number(value('day')),
    hour: Number(value('hour')) % 24, minute: Number(value('minute')), weekday: WEEKDAYS[value('weekday')] ?? 1 }
}

/** Milliseconds to add to UTC to reach `timeZone`'s wall clock at `ms`. */
function offsetAt(ms: number, timeZone: string): number {
  const clock = wallClock(ms, timeZone)
  const aligned = Math.floor(ms / 60_000) * 60_000
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute) - aligned
}

/** The instant at which `timeZone`'s wall clock reads the given minute; two passes settle a zone whose offset changes. */
export function instantOf(day: { year: number; month: number; day: number }, hour: number, minute: number, timeZone: string): number {
  const naive = Date.UTC(day.year, day.month - 1, day.day, hour, minute)
  const once = naive - offsetAt(naive, timeZone)
  return naive - offsetAt(once, timeZone)
}

const DAY = 86_400_000

/**
 * The first instant strictly after `after` at which `schedule` fires.
 * `every` is aligned to epoch windows, so the same window fires once however often the service restarts.
 */
export function nextFireAt(schedule: Schedule, after: number, timeZone: string): number {
  if (schedule.kind === 'every') {
    const interval = schedule.hours * 3_600_000
    return (Math.floor(after / interval) + 1) * interval
  }
  const [hour, minute] = schedule.at.split(':').map(Number) as [number, number]
  const clock = wallClock(after, timeZone)
  for (let ahead = 0; ahead <= 8; ahead += 1) {
    const day = wallClock(after + ahead * DAY, timeZone)
    if (schedule.kind === 'weekly' && day.weekday !== schedule.weekday) continue
    const candidate = instantOf(day, hour, minute, timeZone)
    if (candidate > after) return candidate
  }
  // Eight days cover any weekly weekday; reaching here means the local calendar did something a zone file would explain.
  return after + 7 * DAY
}

/**
 * The most recent occurrence at or before `after`, or undefined when the zone's calendar gives none.
 * Looking back one period at most means a job missed while the service was down fires once, not once per period.
 */
export function lastScheduledAt(schedule: Schedule, after: number, timeZone: string): number | undefined {
  if (schedule.kind === 'every') return Math.floor(after / (schedule.hours * 3_600_000)) * schedule.hours * 3_600_000
  const [hour, minute] = schedule.at.split(':').map(Number) as [number, number]
  for (let back = 0; back <= 7; back += 1) {
    const day = wallClock(after - back * DAY, timeZone)
    if (schedule.kind === 'weekly' && day.weekday !== schedule.weekday) continue
    const candidate = instantOf(day, hour, minute, timeZone)
    if (candidate <= after) return candidate
  }
  return undefined
}

/** The identifier of the occurrence that fires at `at`, stable across restarts so one occurrence makes one Trigger. */
export function fireWindow(schedule: Schedule, at: number, timeZone: string): string {
  if (schedule.kind === 'every') return String(Math.floor(at / (schedule.hours * 3_600_000)))
  const clock = wallClock(at, timeZone)
  return `${clock.year}-${String(clock.month).padStart(2, '0')}-${String(clock.day).padStart(2, '0')}`
}

/** `MM-DD HH:mm` in the job's zone, so a health line never shows a UTC time a reader would misread by hours. */
export function clockLabel(ms: number, timeZone: string): string {
  const clock = wallClock(ms, timeZone)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(clock.month)}-${pad(clock.day)} ${pad(clock.hour)}:${pad(clock.minute)}`
}

/** A version stamp over everything a heartbeat could care about; equal stamps mean nothing has moved. */
export function stampOf(input: { lastEventAt?: number | undefined; draftsMtime?: number | undefined; memoryMtime?: number | undefined }): string {
  return `${input.lastEventAt ?? 0}|${input.draftsMtime ?? 0}|${input.memoryMtime ?? 0}`
}

/** Why a heartbeat ran, recorded on its Decision so "why now" is always answerable. */
export type BeatReason = 'roll-call' | 'on-activity' | 'restart'

/** How long after the last heartbeat a new one is allowed, and how long silence alone may last. */
export interface BeatPolicy { throttleMs: number; silenceMs: number; rideMs: number }

export const BEAT_POLICY: BeatPolicy = { throttleMs: 4 * 3_600_000, silenceMs: 8 * 3_600_000, rideMs: 10 * 60_000 }

/** Whether a local time falls inside `activeHours`, which keeps discoveries out of the night. */
export function inActiveHours(clock: WallClock, hours: { start: string; end: string }): boolean {
  const minutes = clock.hour * 60 + clock.minute
  const [startHour, startMinute] = hours.start.split(':').map(Number) as [number, number]
  const [endHour, endMinute] = hours.end.split(':').map(Number) as [number, number]
  const start = startHour * 60 + startMinute
  const end = endHour * 60 + endMinute
  if (start === end) return true
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}

/** The three-way judgement that decides whether this tick spends a model call. */
export function beatDue(input: {
  now: number
  stamp: string
  lastBeat?: number | undefined
  lastStamp?: string | undefined
  lastHumanAt?: number | undefined
  /** Wall-clock window that beats respect; a job's own schedule is not bounded by it. */
  activeHours?: { start: string; end: string; timeZone: string } | undefined
  policy?: BeatPolicy
}): { beat: false } | { beat: true; reason: BeatReason } {
  const policy = input.policy ?? BEAT_POLICY
  if (input.activeHours && !inActiveHours(wallClock(input.now, input.activeHours.timeZone), input.activeHours)) return { beat: false }
  const age = input.lastBeat === undefined ? Number.POSITIVE_INFINITY : input.now - input.lastBeat
  if (age < policy.throttleMs) return { beat: false }
  if (age >= policy.silenceMs) return { beat: true, reason: 'roll-call' }
  // No stamp to compare against means this process has not beaten yet, so the first look after a restart is not a repeat.
  if (input.lastStamp === undefined) return { beat: true, reason: 'restart' }
  if (input.stamp === input.lastStamp) return { beat: false }
  // A change worth reporting is worth waiting a few minutes for the cache to be warm; otherwise the roll call catches it.
  const hot = input.lastHumanAt !== undefined && input.now - input.lastHumanAt < policy.rideMs
  return hot ? { beat: true, reason: 'on-activity' } : { beat: false }
}

/** One open ticket as the card shows it. */
export interface ChecklistTicket { name: string; stage: string; stuckMs?: number | undefined }
/** One ticket that ended in the window. */
export interface ChecklistEnded { name: string; outcome?: string | undefined }
/** One draft and the part of it nobody has decided. */
export interface ChecklistDraft { name: string; unresolved?: string | undefined }
/** Something a worker promised to come back to, with the day it comes due. */
export interface ChecklistFollow { due: string; what: string }

/** Everything the index card is built from, already gathered by the caller. */
export interface ChecklistInput {
  now: number
  recentHours: number
  humanMessages: number
  open: readonly ChecklistTicket[]
  ended: readonly ChecklistEnded[]
  drafts: readonly ChecklistDraft[]
  /** Follow-ups whose day has come, from the drafts' `要回来跟进` sections. */
  followUps?: readonly ChecklistFollow[]
  /** Dated to-do and risk lines from PROJECTS.md that fall inside the deadline window. */
  deadlines?: readonly string[]
  /** When the team memory last changed, if it did so since the last beat. */
  memoryAt?: number | undefined
  /** Hard ceiling in characters; blocks are dropped whole rather than cut mid-sentence. */
  budget?: number
}

/** The default ceiling: about ten lines, which is what a person reads at a glance. */
export const CHECKLIST_BUDGET = 600

/** `3d`, `5h`, `40m`: coarse on purpose, since the reader decides whether "stuck" matters. */
export function age(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return '?'
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`
  return `${Math.round(ms / 86_400_000)}d`
}

/** Today's local date as `YYYY-MM-DD`, the form a follow-up line and a deadline are compared in. */
export function today(now: number, timeZone: string): string {
  const clock = wallClock(now, timeZone)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${clock.year}-${pad(clock.month)}-${pad(clock.day)}`
}

/**
 * The day a line names: `YYYY-MM-DD`, `MM-DD` or `M月D日`, taken in the year of `now`. Undefined when it names none,
 * because a follow-up without a day would come back on every beat forever.
 */
export function dueDay(text: string, now: number, timeZone: string): string | undefined {
  const clock = wallClock(now, timeZone)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const full = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text)
  if (full) return `${full[1]}-${pad(Number(full[2]))}-${pad(Number(full[3]))}`
  const short = /(?:^|[^\d])(\d{1,2})-(\d{1,2})(?:[^\d]|$)/.exec(text)
  if (short) return `${clock.year}-${pad(Number(short[1]))}-${pad(Number(short[2]))}`
  const chinese = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(text)
  if (chinese) return `${clock.year}-${pad(Number(chinese[1]))}-${pad(Number(chinese[2]))}`
  return undefined
}

/** The follow-ups whose day has come; a date already past still counts, so nothing is lost by being late. */
export function dueFollows(follows: readonly ChecklistFollow[], now: number, timeZone: string): ChecklistFollow[] {
  const day = today(now, timeZone)
  return follows.filter(item => item.due <= day).sort((left, right) => left.due.localeCompare(right.due))
}

/** The deadline window: a dated to-do shows up a week before it is due and a week after, then it is history. */
export const DEADLINE_WINDOW_DAYS = 7

/** Dated 待办 / 风险 lines from PROJECTS.md inside the deadline window, trimmed for the card and capped at three. */
export function deadlineLines(markdown: string, now: number, timeZone: string): string[] {
  const day = today(now, timeZone)
  const floor = new Date(Date.parse(`${day}T00:00:00Z`) - DEADLINE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10)
  const ceiling = new Date(Date.parse(`${day}T00:00:00Z`) + DEADLINE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10)
  // Only a line that declares its own due date counts: PROJECTS lines also cite past dates as evidence, and those are
  // history, not deadlines. The convention is the same one a draft's follow-up uses — the date comes first.
  return markdown.split('\n')
    .map(line => line.trim())
    .filter(line => /^[-*]\s*(待办|风险|截止)\s*[：:]\s*\d/.test(line))
    .flatMap(line => {
      const due = dueDay(line, now, timeZone)
      if (!due || due < floor || due > ceiling) return []
      return [`${due} ${line.replace(/^[-*]\s*/, '').slice(0, 60)}`]
    })
    .slice(0, 3)
}

const OUTCOMES: Record<string, string> = { completed: '完成', merged: '已合并', dropped: '无需处理', stopped: '人叫停', closed: '已关闭' }

/**
 * Build the index card a heartbeat reads: what is open and how long it has been stuck, what ended, what nobody has
 * decided, and whether the memory moved. It points at things; the content stays behind `orchestrator_read`.
 */
export function buildChecklist(input: ChecklistInput): string {
  const budget = input.budget ?? CHECKLIST_BUDGET
  const blocks: string[] = []
  if (input.open.length) {
    const lines = input.open.slice(0, 5).map(ticket => `- ${ticket.name} [${ticket.stage}]${ticket.stuckMs === undefined ? '' : ` · 卡 ${age(ticket.stuckMs)}`}`)
    // The count is the real one even when the list is short, so "6 open" with five lines reads as a cap, not an error.
    if (input.open.length > 5) lines.push(`- …另 ${input.open.length - 5} 张`)
    blocks.push(`## 在办 ${input.open.length}`, ...lines)
  }
  if (input.followUps?.length) {
    blocks.push('## 要回来跟进', ...input.followUps.slice(0, 3).map(item => `- ${item.due} ${item.what}`))
  }
  if (input.deadlines?.length) {
    blocks.push('## 临近截止', ...input.deadlines.slice(0, 3).map(line => `- ${line}`))
  }
  if (input.drafts.length) {
    const lines = input.drafts.slice(0, 2).map(draft => `- ${draft.name}${draft.unresolved ? ` → ${draft.unresolved}` : ''}`)
    blocks.push('## 未决草稿', ...lines)
  }
  if (input.ended.length) {
    const counts = new Map<string, number>()
    for (const ticket of input.ended) counts.set(ticket.outcome ?? '未知', (counts.get(ticket.outcome ?? '未知') ?? 0) + 1)
    const summary = [...counts].map(([outcome, count]) => `${OUTCOMES[outcome] ?? outcome} ${count}`).join(' / ')
    const names = input.ended.slice(0, 5).map(ticket => ticket.name).join('、')
    blocks.push(`## 最近 ${input.recentHours}h 结束 ${input.ended.length}（${summary}）：${names}`)
  }
  if (input.memoryAt !== undefined) {
    // Relative on purpose: an absolute time here would be UTC, and a card read in Shanghai would misread it by hours.
    blocks.push(`## 记忆 ${age(input.now - input.memoryAt)}前有更新；细节用 orchestrator_read memory`)
  }
  const header = `# 心跳 上次以来 ${input.humanMessages} 条人类消息`
  const NOTE = '\n（已截断，完整用 orchestrator_read memory）'
  let text = header
  let truncated = false
  for (const block of blocks) {
    if (text.length + block.length + 1 > budget - NOTE.length) { truncated = true; break }
    text += `\n${block}`
  }
  // The note is reserved before blocks are added, so it is never cut in half by the ceiling.
  return (truncated && text !== header ? text + NOTE : text).slice(0, budget)
}

/** True when the card holds nothing a person would act on, so the beat is skipped without spending a model call. */
export function emptyChecklist(input: Pick<ChecklistInput, 'open' | 'ended' | 'drafts' | 'followUps' | 'deadlines'>): boolean {
  return input.open.length === 0 && input.ended.length === 0 && input.drafts.length === 0
    && !input.followUps?.length && !input.deadlines?.length
}
