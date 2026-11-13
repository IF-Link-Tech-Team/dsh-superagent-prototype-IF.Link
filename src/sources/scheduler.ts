/**
 * Scheduler Source: turns time into Triggers.
 *
 * `001-domain.md` says a condition that needs waiting is an ordinary Source and that Eval never waits, so a reminder,
 * a periodic check or a heartbeat is a Trigger like any other — which is what lets it pass the same gate, reach the same
 * Ticket and leave the same audit trail. This Source reads no platform API: it looks at the clock, the local state and
 * the files the team memory lives in.
 *
 * Scheduled Triggers are senderless (`human: false`, empty `actor.id`), so `machineGate` admits them at most as inferred
 * candidates, and `meta.allowRules` names the one rule they may be accepted under.
 */
import type { Context } from '@deepseek-ai/cordis'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { key, latestReport, ticketStage, type OutboundMessage, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { checkedImText } from '../infra/text.ts'
import { family, record, type Key } from '../kv.ts'
import { sourceContext, type Activity, type SourceContext } from './host.ts'
import type { ChannelLink, SourceKind } from './kind.ts'
import { beatDue, buildChecklist, clockLabel, deadlineLines, dueDay, dueFollows, emptyChecklist, fireWindow, JobSchema, lastScheduledAt,
  nextFireAt, stampOf, type ChecklistDraft, type ChecklistEnded, type ChecklistFollow, type ChecklistTicket } from './scheduler-job.ts'

export { BEAT_POLICY, beatDue, buildChecklist, emptyChecklist, JobSchema, ScheduleSchema, stampOf } from './scheduler-job.ts'

export const SOURCE = 'scheduler'
/** One tick per minute: a job may fire up to a minute late, which no team notice cares about, and it costs no I/O. */
const TICK_MS = 60_000
/** An occurrence older than this was missed while the service was down; report it next period instead of at once. */
const GRACE_MS = 6 * 3_600_000
/** The zone a job's wall-clock time is read in; explicit so a host in UTC cannot shift every job by hours in silence. */
const DEFAULT_ZONE = 'Asia/Shanghai'
/**
 * The rules a scheduled Trigger may be accepted under. A heartbeat is a periodic check, never an unclaimed request or a
 * history lookup, so it is confined here in code rather than trusted to the prompt.
 */
export const ALLOWED_RULES: readonly string[] = ['periodic-check']
/** The window the card summarises: what ended in the last day is the part a person still remembers. */
const RECENT_HOURS = 24
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/

const KV = {
  /** The occurrence window each job last fired, so a restart or a second tick cannot fire it twice. */
  fired: family<string, [job: string]>('scheduler-fired:'),
  /** When the last heartbeat ran, the stamp it saw and how many human messages had arrived, so the next card's count is real. */
  beat: record<{ at: number; stamp: string; reason: string; humanTriggers: number }>('scheduler-beat'),
}

export const SchedulerConfigSchema = z.object({
  timeZone: z.string().refine(zone => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true } catch { return false }
  }, 'Unknown time zone').default(DEFAULT_ZONE),
  jobs: z.array(JobSchema).default([]).refine(jobs => new Set(jobs.map(job => job.id)).size === jobs.length, 'Duplicate job ids'),
  /** The proactive half: a periodic look at whether the team's own state says something needs attention. */
  heartbeat: z.object({
    enabled: z.boolean().default(false),
    /** Where a heartbeat's result is delivered; a heartbeat without one never runs. */
    chatId: z.string().trim().default(''),
    /** Discoveries stay out of the night; a job's own schedule is not bounded by this. */
    activeHours: z.object({ start: z.string().regex(CLOCK), end: z.string().regex(CLOCK) }).strict()
      .default({ start: '08:00', end: '23:00' }),
  }).strict().default({ enabled: false, chatId: '', activeHours: { start: '08:00', end: '23:00' } }),
}).strict()
export type SchedulerConfig = z.infer<typeof SchedulerConfigSchema>

/** The Trigger one occurrence of `job` produces; its id derives from the window, so a repeat is a duplicate, not a second Ticket. */
export function scheduledTrigger(job: { id: string; text: string; chatId: string }, at: number, window: string): Trigger {
  const thread = `job:${job.id}`
  return { id: key('cron', job.id, window), source: SOURCE, threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date(at).toISOString(), text: job.text,
    channel: { source: SOURCE, thread, address: { chatId: job.chatId } },
    meta: { jobId: job.id, window, allowRules: [...ALLOWED_RULES] } }
}

/** The Trigger a heartbeat sends: one Thread for every beat, so Evals run one at a time and ticks merge into the next batch. */
export function heartbeatTrigger(card: string, at: number, window: string, chatId: string): Trigger {
  return { id: key('beat', window), source: SOURCE, threads: [{ source: SOURCE, id: 'beat' }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date(at).toISOString(), text: card,
    channel: { source: SOURCE, thread: 'beat', address: { chatId } },
    meta: { beat: true, window, allowRules: [...ALLOWED_RULES] } }
}

/** A ticket's directory name ends with its short id; the card reads better without it. */
const displayName = (ticket: Ticket): string => (ticket.execution?.name || ticket.title).replace(/-[0-9a-f]{12}$/, '')

/** When an open ticket last moved: its latest report, or its creation. */
const movedAt = (ticket: Ticket): number | undefined => {
  const at = Date.parse(latestReport(ticket)?.at ?? ticket.createdAt)
  return Number.isFinite(at) ? at : undefined
}

/** The open tickets as the card lists them, with the stage and how long each has waited. */
export function openEntries(tickets: readonly Ticket[], now: number): ChecklistTicket[] {
  return tickets.map(ticket => {
    const stage = ticketStage(ticket)
    const at = movedAt(ticket)
    return { name: displayName(ticket), stage: 'action' in stage ? `${stage.stage}/${stage.action}` : stage.stage,
      stuckMs: at === undefined ? undefined : Math.max(0, now - at) }
  })
}

/** The tickets that ended within `hours`, so the card can say what was finished since the last look. */
export function endedEntries(tickets: readonly Ticket[], now: number, hours: number): ChecklistEnded[] {
  const floor = now - hours * 3_600_000
  return tickets.flatMap((ticket): ChecklistEnded[] => {
    const at = ticket.ended ? Date.parse(ticket.ended.at) : Number.NaN
    return Number.isFinite(at) && at >= floor ? [{ name: displayName(ticket), outcome: ticket.ended?.outcome }] : []
  })
}

/** The lines of the section whose heading contains `heading`, without bullets or blank entries. */
function sectionOf(body: string, heading: string): string[] {
  const pattern = new RegExp(`##\\s*[^\\n]*${heading}[^\\n]*\\n+([\\s\\S]*?)(?=\\n##\\s|$)`)
  return (pattern.exec(body)?.[1] ?? '').split('\n')
    .map(text => text.replace(/^[-*\s]+/, '').trim())
    .filter(text => text.length > 0)
}

/** The part of a draft nobody has decided, which is one part a heartbeat needs to know about. */
const unresolvedOf = (body: string): string | undefined => sectionOf(body, '没解决')[0]?.slice(0, 80)

/** The follow-ups a draft promises, each with the day it comes due; a line with no day is dropped, not shown forever. */
const followsOf = (body: string, now: number, timeZone: string): ChecklistFollow[] =>
  sectionOf(body, '要回来跟进').flatMap(line => {
    const due = dueDay(line, now, timeZone)
    return due ? [{ due, what: line.replace(/^\d{4}-\d{1,2}-\d{1,2}\s*/, '').slice(0, 60) }] : []
  })

/**
 * The drafts waiting for Dreaming: what nobody has decided, the follow-ups they promise, and when the folder last
 * changed. A missing folder is not an error, just no drafts.
 */
export async function draftEntries(memoryDir: string, now: number, timeZone: string):
Promise<{ entries: ChecklistDraft[]; follows: ChecklistFollow[]; mtime?: number | undefined }> {
  const dir = join(memoryDir, 'drafts', 'inbox')
  const mtime = await stat(dir).then(found => found.mtimeMs).catch(() => undefined)
  const names = (await readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith('.md') && !name.startsWith('_')).slice(0, 5)
  const entries: ChecklistDraft[] = []
  const follows: ChecklistFollow[] = []
  for (const name of names) {
    const body = await readFile(join(dir, name), 'utf8').catch(() => '')
    entries.push({ name: name.replace(/\.md$/, '').replace(/^[0-9a-f]{8}-/, ''), unresolved: unresolvedOf(body) })
    follows.push(...followsOf(body, now, timeZone))
  }
  return { entries, follows, mtime }
}

/** PROJECTS.md as stored, or empty when the deployment keeps none; only its dated lines reach a card. */
export async function projectNotes(memoryDir: string): Promise<string> {
  return readFile(join(memoryDir, 'PROJECTS.md'), 'utf8').catch(() => '')
}

/** When the team memory last changed, or undefined when none of its files exist. */
export async function memoryMtime(memoryDir: string): Promise<number | undefined> {
  const stamps = await Promise.all(['TEAM.md', 'PROJECTS.md', 'HEADINGS.md']
    .map(name => stat(join(memoryDir, name)).then(found => found.mtimeMs).catch(() => 0)))
  const newest = Math.max(0, ...stamps)
  return newest > 0 ? newest : undefined
}

/** Sends a result into the job's chat; `+messages-send` carries an idempotency key, so a retry cannot double-post. */
async function send(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const chatId = message.channel.address.chatId
  if (!chatId) throw new Error('Missing scheduler chat')
  await host.commands.lark(['im', '+messages-send', '--chat-id', chatId, '--markdown', checkedImText(message.text),
    '--idempotency-key', message.id])
  return 'sent'
}

export const schedulerKind: SourceKind<SchedulerConfig> = {
  kind: SOURCE,
  title: { zh: '定时与心跳', en: 'Schedule' },
  description: { zh: '把时间变成触发器：到点的定时任务与主动心跳。只看本机时钟、本地状态和记忆文件，不调任何平台 API。',
    en: 'Turns time into Triggers: scheduled jobs and the proactive heartbeat. It reads the local clock, state and memory files, never a platform API.' },
  schema: SchedulerConfigSchema,
  // Jobs hold a nested schedule, which the panel's row editor cannot express; configure them with orchestrator_settings_save.
  fields: [],
  health: ['scheduler'],
  // `observed` is what lets a senderless event reach the assessment at all; without it `machineGate` answers `not_human`.
  scope: () => ({ listened: true, observed: true, row: 'beat' }),
  policy: {
    unnamed: { person: { zh: '定时任务', en: 'Scheduled job' }, bot: { zh: '定时任务', en: 'Scheduled job' } },
    // A scheduled Trigger has no sender, so it can never be an explicit request and needs no allowed list.
    schema: z.object({ allowed: z.array(z.object({ id: z.string() })).default([]) }).strict(),
    fields: [],
    explicit: { zh: '定时与心跳事件没有发起人，最多只能成为推断候选，由评估按规则判断。',
      en: 'A scheduled or heartbeat event has no sender: it can only become an inferred candidate, which the assessment judges against the rules.' },
    rows: () => [{ id: 'beat', label: { zh: '定时与心跳', en: 'Schedules and heartbeats' }, note: { zh: '默认忽略', en: 'Ignored by default' },
      cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } }],
  },
  channel: {
    send,
    link: (address): ChannelLink => ({ url: '', label: { zh: `定时任务 → ${address.chatId ?? ''}`, en: `Schedule → ${address.chatId ?? ''}` } }),
  },
}

/**
 * The part of a Source context one tick needs. Narrow on purpose: a tick cannot read a Session or send to a channel, so
 * the test below can drive the whole schedule with a plain object.
 */
export interface SchedulerHost {
  config<C extends Record<string, unknown>>(kind: string): C | undefined
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
  state: { get<V>(key: Key<V>): V | undefined; set<V>(key: Key<V>, value: V | undefined): void }
  tickets: { open(): Ticket[]; list(): Ticket[] }
  activity(): Activity
  configured(): boolean
  deployment: { memoryDir: string }
}

/** One occurrence of each due job, at most once per window. */
async function runJobs(ctx: SchedulerHost, now: number, current: SchedulerConfig, lines: string[]): Promise<void> {
  for (const job of current.jobs) {
    if (!job.enabled) continue
    if (!job.chatId) { lines.push(`${job.id}: 未配置 chatId，跳过`); continue }
    const at = lastScheduledAt(job.schedule, now, current.timeZone)
    if (at === undefined) continue
    const window = fireWindow(job.schedule, at, current.timeZone)
    // An occurrence older than the grace was missed while the service was down, or is yesterday's window of a job whose
    // time has not come round yet. Neither is reported late; the line says when the next one is instead.
    if (now - at > GRACE_MS) {
      lines.push(`${job.id}: 下次 ${clockLabel(nextFireAt(job.schedule, now, current.timeZone), current.timeZone)}`)
      continue
    }
    if (ctx.state.get(KV.fired(job.id)) === window) {
      lines.push(`${job.id}: 下次 ${clockLabel(nextFireAt(job.schedule, now, current.timeZone), current.timeZone)}`)
      continue
    }
    try {
      const result = await ctx.receive(scheduledTrigger(job, at, window))
      ctx.state.set(KV.fired(job.id), window)
      lines.push(`${job.id}: ${result === 'stored' ? '已触发' : result} ${window}`)
    } catch (error) {
      // Left unmarked on purpose: the next tick retries the same window, and the Trigger id keeps it one Ticket.
      lines.push(`${job.id}: 触发失败 ${String(error).slice(0, 80)}`)
    }
  }
}

/** The heartbeat: look, decide whether the look is worth a model call, and address it only when it is. */
async function runHeartbeat(ctx: SchedulerHost, now: number, current: SchedulerConfig, lines: string[]): Promise<void> {
  const { heartbeat } = current
  if (!heartbeat.enabled) return
  if (!heartbeat.chatId) { lines.push('心跳: 未配置 chatId，跳过'); return }
  if (!ctx.configured()) { lines.push('心跳: 等待部署检查'); return }
  const memoryDir = ctx.deployment.memoryDir
  const [drafts, memory, projects] = await Promise.all([draftEntries(memoryDir, now, current.timeZone),
    memoryMtime(memoryDir), projectNotes(memoryDir)])
  const activity = ctx.activity()
  const stamp = stampOf({ lastEventAt: activity.lastEventAt, draftsMtime: drafts.mtime, memoryMtime: memory })
  const previous = ctx.state.get(KV.beat)
  const decision = beatDue({ now, stamp, lastBeat: previous?.at, lastStamp: previous?.stamp, lastHumanAt: activity.lastHumanAt,
    activeHours: { ...heartbeat.activeHours, timeZone: current.timeZone } })
  if (!decision.beat) return
  const humanMessages = Math.max(0, (activity.humanTriggers ?? 0) - (previous?.humanTriggers ?? 0))
  const input = { now, recentHours: RECENT_HOURS, humanMessages,
    open: openEntries(ctx.tickets.open(), now),
    ended: endedEntries(ctx.tickets.list(), now, RECENT_HOURS).slice(0, 5),
    drafts: drafts.entries,
    followUps: dueFollows(drafts.follows, now, current.timeZone),
    deadlines: deadlineLines(projects, now, current.timeZone),
    // Only a change since the last beat is worth the reader's attention; an unchanged file is one it already saw.
    // On the first look there is no earlier beat to compare with, so the memory counts as news.
    memoryAt: memory !== undefined && (!previous || memory > previous.at) ? memory : undefined }
  const next = { at: now, stamp, reason: decision.reason, humanTriggers: activity.humanTriggers ?? 0 }
  if (emptyChecklist(input)) {
    // The second gate: nothing a person would act on, so the model is not called at all.
    ctx.state.set(KV.beat, { ...next, reason: `${decision.reason}:quiet` })
    lines.push(`心跳 ${decision.reason}: 无内容，未调用模型`)
    return
  }
  try {
    await ctx.receive(heartbeatTrigger(buildChecklist(input), now, new Date(now).toISOString().slice(0, 16), heartbeat.chatId))
    ctx.state.set(KV.beat, next)
    lines.push(`心跳 ${decision.reason}`)
  } catch (error) {
    lines.push(`心跳失败 ${String(error).slice(0, 80)}`)
  }
}

/** One pass of the clock: every due job and the heartbeat, and the lines a person reads in health. */
export async function tickScheduler(ctx: SchedulerHost, now: number): Promise<string[]> {
  const current = ctx.config<SchedulerConfig>(SOURCE)
  if (!current) return []
  const lines: string[] = []
  await runJobs(ctx, now, current, lines)
  await runHeartbeat(ctx, now, current, lines)
  return lines
}

/** Runs the clock until the signal aborts, turning due jobs and due heartbeats into Triggers and nothing else. */
async function runScheduler(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  const config = (): SchedulerConfig | undefined => ctx.config<SchedulerConfig>(SOURCE)
  const report = (state: 'starting' | 'ready' | 'paused' | 'error', detail: string): void => ctx.report('scheduler', { state, detail })
  const tick = async (): Promise<void> => {
    // The configuration is read again on every tick: a Source switched on, a job added or a heartbeat enabled in the
    // panel must take effect without a restart, so the clock keeps running and only the report says it is idle.
    const current = config()
    if (!current) { report('paused', 'Off'); return }
    if (!current.jobs.some(job => job.enabled) && !current.heartbeat.enabled) {
      report('paused', 'No job and no heartbeat is configured')
      return
    }
    try {
      const lines = await tickScheduler(ctx, Date.now())
      report('ready', lines.join('；') || '没有启用的任务')
    } catch (error) {
      // A failing tick must not stop the clock: the next one retries, and a person sees the problem in health.
      report('error', `tick 失败：${String(error).slice(0, 160)}`)
    }
  }

  await tick()
  await new Promise<void>(resolve => {
    const timer = setInterval(() => { void tick() }, TICK_MS)
    timer.unref?.()
    signal.addEventListener('abort', () => { clearInterval(timer); resolve() }, { once: true })
  })
  report('paused', 'Off')
}

export const name = 'dsh-superagent-scheduler'
export const inject = ['orchestrator']

/** Registers the kind and starts the clock; both stop when the plugin unloads. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(schedulerKind), 'scheduler: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runScheduler(sourceContext(ctx.orchestrator, schedulerKind), controller.signal)
    return async () => { controller.abort(); await running }
  })
}
