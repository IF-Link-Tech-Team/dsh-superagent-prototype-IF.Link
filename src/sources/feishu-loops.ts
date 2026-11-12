/** Feishu background loops: live event stream consumer, chat/topic history sweeps, chat name refresh, and subscribed thread polling. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { liveTicket, threadKey, type Thread, type Trigger } from '../core/index.ts'
import { feishuChatLink } from './feishu-channel.ts'
import type { FeishuBot } from '../deployment.ts'
import { larkCallStats, validItems, type Commands, type Tally } from '../infra/commands.ts'
import { readFeishu, type FeishuRef } from './feishu-read.ts'
import { feishuRef, feishuTime, feishuTrigger, HistoricalMessageSchema, historyEvent, HistoryPageSchema, SOURCE, topicEvent }
  from './feishu-trigger.ts'
import { health, type Health, type SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import { cursorAt, POLL_HORIZON_MS, polled, pollThreads as pollEach } from './poll.ts'
import type { FeishuConfig } from './feishu.ts'

/** Rounds (one per minute) a single chat must fail in a row before `history` turns red. */
const HISTORY_FAILURE_ROUNDS = 3
/**
 * How often the loop wakes up. A round now costs a call or two: the hourly and two-hourly sweeps, not the rounds,
 * are what read Feishu, so the cadence is cheap and a chat that just received an event is swept within a minute.
 */
const ROUND_MS = 60_000
/** A chat that received an event is swept once, this long afterwards, so an event the stream lost still lands quickly. */
const FAST_SWEEP_DELAY_MS = 30_000
const minutes = (value: number): number => value * 60_000
/**
 * Reads a cadence in minutes from the environment, so an operator can retune a sweep without a rebuild. Both the
 * environment value and the fallback are minutes; the callers compare the result against millisecond timestamps.
 */
const envMinutes = (name: string, fallback: number): number => {
  const value = Number(process.env[name])
  return minutes(Number.isFinite(value) && value > 0 ? value : fallback)
}
/**
 * Cadences of the background sweeps. Live events deliver almost every message (99% of the human ones, measured over a
 * week), so the sweeps are a safety net and may be slow: they only have to catch what the stream lost, plus the app
 * messages Feishu does not push.
 */
export const FEISHU_TIMING = {
  /** Every chat is swept this often for messages the stream lost. */
  chatSweep: envMinutes('DSH_FEISHU_CHAT_SWEEP_MINUTES', 60),
  /** A topic that received an event recently is swept on every round. */
  topicHot: envMinutes('DSH_FEISHU_TOPIC_HOT_MINUTES', 30),
  /** Every topic that saw a message this recently is swept by the topic pass; older ones are left to the live stream. */
  topicRecent: envMinutes('DSH_FEISHU_TOPIC_RECENT_MINUTES', 720),
  /** Every topic is swept this often, hot or not. */
  topicSweep: envMinutes('DSH_FEISHU_TOPIC_SWEEP_MINUTES', 120),
  /** A subscribed thread is polled at most this often. */
  threadPoll: envMinutes('DSH_FEISHU_THREAD_POLL_MINUTES', 10),
  /** A thread whose last activity is older than this is left to the ticket-driven poll. */
  threadRecent: envMinutes('DSH_FEISHU_THREAD_RECENT_MINUTES', 60),
  /** The joined-chat list is a display aid, not a message path. */
  chatNames: envMinutes('DSH_FEISHU_CHAT_NAMES_MINUTES', 60),
}

/**
 * Markers of recent live events, kept in memory: a restart starts cold on purpose, because the first round (and every
 * reconnect) sweeps everything the markers would otherwise have spared.
 */
const activity = { chat: new Map<string, number>(), topic: new Map<string, number>(), thread: new Map<string, number>() }
/** Set by the first round and by every event-stream restart: the missed window has to be read, not simply skipped. */
let catchUpRequested = true

/** Forgets the in-memory markers and asks for a full sweep; tests and a restored deployment both use it. */
export function resetFeishuLoops(): void {
  activity.chat.clear(); activity.topic.clear(); activity.thread.clear(); catchUpRequested = true
}
/** Asks the next round to read every chat, topic, and thread: what the event stream may have missed while it was down. */
export function requestFeishuCatchUp(): void { catchUpRequested = true }
/**
 * Records a live event so the sweeps revisit its chat and topic within a minute. Only the event path calls this: a
 * message read by a sweep must not mark its own topic hot, or every sweep would keep every topic hot.
 */
export function noteFeishuEvent(trigger: Trigger, at = Date.now()): void {
  const chatId = String(trigger.meta.chatId ?? '')
  if (chatId) activity.chat.set(chatId, at)
  const threadId = String(trigger.meta.threadId ?? '')
  if (threadId) activity.topic.set(threadId, at)
}

/** One round's memo of Feishu reads, so the chat, topic, and thread sweeps never read the same page twice in a round. */
export interface FeishuCache {
  lark<T>(commands: Pick<Commands, 'lark'>, args: string[], cwd?: string): Promise<T>
  readonly size: number
}
export function feishuCache(): FeishuCache {
  const memo = new Map<string, Promise<unknown>>()
  return {
    lark<T>(commands: Pick<Commands, 'lark'>, args: string[], cwd?: string): Promise<T> {
      const key = [cwd ?? '', ...args].join('\u0000')
      let pending = memo.get(key) as Promise<T> | undefined
      if (pending) return pending
      pending = commands.lark<T>(args, cwd)
      memo.set(key, pending)
      // A failed read must not be memoized, or one flaky call would answer for the rest of the round.
      void pending.catch(() => memo.delete(key))
      return pending
    },
    get size(): number { return memo.size },
  }
}

/**
 * Returns an error health once one chat has failed `HISTORY_FAILURE_ROUNDS` rounds in a row, or undefined so a single
 * flaky round (Feishu occasionally answers 2200 for one chat and recovers by itself) keeps `history` green.
 */
export function historyFailureHealth(failures: ReadonlyMap<string, number>, errors: readonly string[]): Health | undefined {
  const rounds = Math.max(0, ...failures.values())
  return rounds >= HISTORY_FAILURE_ROUNDS
    ? health('error', 'pollFailures', { count: String(rounds), error: errors.join(' / ') })
    : undefined
}

export const runFeishu = (ctx: SourceContext, signal: AbortSignal): Promise<unknown> =>
  Promise.allSettled([watch, backfillLoop, chatNamesLoop].map(loop => loop(ctx, signal)))
const enabled = (ctx: SourceContext): FeishuConfig | undefined => ctx.config<FeishuConfig>(SOURCE)
const bot = (ctx: SourceContext): FeishuBot => {
  const resolved = ctx.deployment.feishu
  if (!resolved) throw new Error('The Feishu Source has no working bot CLI')
  return resolved
}
async function receive(ctx: SourceContext, trigger: Trigger): Promise<void> {
  await ctx.receive(trigger)
  const chatId = String(trigger.meta.chatId ?? '')
  if (!chatId) return
  const name = ctx.state.get(KV.sources.labels(SOURCE))?.[chatId] ?? chatId
  const chat = trigger.meta.direct === true ? { value: { zh: '私聊', en: 'Direct message' } } : { value: name }
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { url: chatLink(ctx, chatId), facts: { chat } })
}
const chatLink = (ctx: SourceContext, chatId: string): string => feishuChatLink(ctx.deployment.feishu?.brand ?? 'feishu', chatId)
function available(ctx: SourceContext): boolean {
  if (ctx.configured() && ctx.deployment.feishu) return true
  const waiting = health('paused', ctx.configured() ? 'feishuCliUnset' : 'setupPending')
  ctx.report('feishu', ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : waiting)
  return false
}

/** Runs the live event consumer only while the Source is enabled; disabling it stops the consumer within five seconds. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the bot; until then nothing runs.
  if (!available(ctx)) return
  let retry: number | undefined
  while (!signal.aborted) {
    if (!enabled(ctx)) {
      ctx.report('feishu', health('paused', 'sourceOff'))
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    const running = new AbortController()
    const check = setInterval(() => { if (!enabled(ctx)) running.abort() }, 5000)
    const stop = () => running.abort()
    signal.addEventListener('abort', stop, { once: true })
    const began = Date.now()
    try { await consume(ctx, running.signal) }
    catch (error) { if (!running.signal.aborted) ctx.report('feishu', { state: 'error', detail: String(error) }) }
    finally { clearInterval(check); signal.removeEventListener('abort', stop) }
    if (running.signal.aborted) continue
    // The consumer stopped, so whatever it missed until it is back has to be read rather than assumed delivered.
    requestFeishuCatchUp()
    retry = consumerRetry(retry, Date.now() - began)
    await delay(retry, undefined, { signal }).catch(() => {})
  }
}
/** Wait before restarting the event consumer: 1s after a run that stayed up for a minute, otherwise exponential backoff up to 60s. */
export const consumerRetry = (previous: number | undefined, ranMs: number): number =>
  previous === undefined || ranMs >= 60_000 ? 1000 : Math.min(previous * 2, 60_000)
async function consume(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  const child = spawn(bot(ctx).cli, ['event', 'consume', 'im.message.receive_v1', '--as', 'bot'],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
  const stdout = createInterface({ input: child.stdout }); const stderr = createInterface({ input: child.stderr })
  let chain = Promise.resolve(); let diagnostic = ''; let ready = false
  const stop = (): void => { child.stdin.end(); child.kill('SIGTERM') }
  signal.addEventListener('abort', stop, { once: true })
  const timeout = setTimeout(() => { diagnostic = 'Feishu event consumer did not become ready within 45 seconds'; stop() }, 45_000)
  // stdout and stderr are separate pipes, so a line read from one may be handled before a line the other wrote earlier:
  // a late "ready" must not paint over the fault that arrived first.
  let faulted = false
  const fault = (detail: string): void => { faulted = true; ctx.report('feishu', { state: 'error', detail }) }
  stderr.on('line', (line: string) => {
    diagnostic = line.slice(0, 4000)
    if (line.startsWith('[event] ready')) {
      ready = true; clearTimeout(timeout)
      if (!faulted) ctx.report('feishu', { state: 'ready', detail: 'Listening for bot events', at: new Date().toISOString() })
    } else if (/WARN|drop|error/.test(line)) fault(diagnostic)
  })
  stdout.on('line', (line: string) => {
    chain = chain.then(async () => {
      if (line.length > 1_048_576) throw new Error('Feishu event exceeds 1 MiB')
      const trigger = feishuTrigger(JSON.parse(line), bot(ctx).botId, bot(ctx).appId)
      // Events already read when the Source is disabled are dropped; the consumer stops shortly after.
      if (!trigger || !enabled(ctx)) return
      noteFeishuEvent(trigger)
      const chats = ctx.state.get(KV.feishu.chats) ?? {}
      chats[String(trigger.meta.chatId)] = trigger.meta.direct === true
      ctx.state.set(KV.feishu.chats, chats)
      await receive(ctx, trigger)
    }).catch(error => fault(String(error)))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      const exited = (code: number | null) => new Error(`Feishu event consumer exited (${code}, ready=${ready}): ${diagnostic}`)
      child.once('close', (code) => signal.aborted ? resolve() : reject(exited(code)))
    })
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', stop); stdout.close(); stderr.close(); await chain }
}

/** Refreshes the map of joined chats (`chat_id -> name`); throws on failure so the previously stored list remains intact. */
export async function refreshChatNames(ctx: SourceContext, signal?: AbortSignal): Promise<Record<string, string>> {
  const commands = ctx.commands.withSignal(signal)
  const result = z.looseObject({ chats: z.array(z.looseObject({ chat_id: z.string(), name: z.string().nullish() })).optional() })
    .parse(await commands.lark(['im', '+chat-list', '--page-all', '--page-size', '100']))
  const names = Object.fromEntries((result.chats ?? []).filter(chat => chat.name).map(chat => [chat.chat_id, chat.name!]))
  ctx.state.set(KV.sources.labels(SOURCE), names)
  return names
}
/** Rereads the chat list hourly: its names label chats in the panel, and a new chat shows up within that hour. */
async function chatNamesLoop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!available(ctx)) return
  while (!signal.aborted) {
    if (enabled(ctx)) {
      try { await refreshChatNames(ctx, signal) }
      catch { /* Names are a display aid; the stored list stays until a later read succeeds. */ }
    }
    await delay(FEISHU_TIMING.chatNames, undefined, { signal }).catch(() => {})
  }
}

/** The chats this Source reads: the configured ones plus the direct chats it has already seen, while they are received. */
function sweepableChats(ctx: SourceContext, config: FeishuConfig): Record<string, boolean> {
  const seen = ctx.state.get(KV.feishu.chats) ?? {}
  const known = Object.entries(seen).filter(([, direct]) => direct && config.directMessages)
  return { ...Object.fromEntries(config.chats.map(chat => [chat.chatId, false])), ...Object.fromEntries(known) }
}
/** Forgets markers older than the longest window they still influence, so a long-running process does not accumulate them. */
function pruneActivity(now: number): void {
  const stale = now - Math.max(FEISHU_TIMING.topicSweep, FEISHU_TIMING.threadRecent)
  for (const markers of [activity.chat, activity.topic, activity.thread]) {
    for (const [key, at] of markers) if (at < stale) markers.delete(key)
  }
}
/** The chats that received an event long enough ago to be swept, and have not been swept since that event. */
function fastChats(chats: Record<string, boolean>, now: number, swept: Map<string, number>): [string, boolean][] {
  return Object.entries(chats).flatMap(([chatId, direct]) => {
    const at = activity.chat.get(chatId)
    if (at === undefined || now - at < FAST_SWEEP_DELAY_MS || (swept.get(chatId) ?? 0) >= at) return []
    return [[chatId, direct] as [string, boolean]]
  })
}
/**
 * Sweeps history in two tiers instead of reading every chat on every round: a chat is swept once shortly after it
 * receives an event, and every chat is swept hourly as a floor. Everything the event stream delivered is deduplicated
 * by its deterministic Trigger id, so an overlap costs a call but never a duplicate.
 */
async function backfillLoop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!available(ctx)) { ctx.report('history', health('paused', 'feishuBotMissing')); return }
  // Consecutive failures per chat. Feishu occasionally answers 2200 for a single chat and recovers on its own;
  // one flaky round must not turn the whole component red, so only a chat failing HISTORY_FAILURE_ROUNDS rounds
  // in a row is reported. Counters live in memory: a restart is a fresh start, and no stale count survives a night.
  const failures = new Map<string, number>()
  let lastChatSweep = 0
  let lastTopicSweep = 0
  let swept = new Map<string, number>()
  let reportedCalls = larkCallStats().total
  while (!signal.aborted) {
    const config = enabled(ctx)
    if (!config) {
      ctx.report('history', health('paused', 'sourceOff'))
      await delay(ROUND_MS, undefined, { signal }).catch(() => {})
      continue
    }
    const now = Date.now()
    const catchUp = catchUpRequested
    catchUpRequested = false
    const chats = sweepableChats(ctx, config)
    const chatSweep = catchUp || now - lastChatSweep >= FEISHU_TIMING.chatSweep
    const topicSweep = catchUp || now - lastTopicSweep >= FEISHU_TIMING.topicSweep
    const cache = feishuCache()
    const errors: string[] = []
    const tally = { skipped: 0 }
    // The full sweep reads every topic anyway, so its chat pass leaves topics alone and the round stays cheap.
    const mode: TopicMode = topicSweep ? 'none' : 'hot'
    const targets = chatSweep ? Object.entries(chats) : fastChats(chats, now, swept)
    for (const [chatId, direct] of targets) {
      if (signal.aborted) break
      await sweepChat(ctx, chatId, direct, signal, tally, failures, errors, mode, cache, catchUp)
      swept.set(chatId, now)
    }
    if (chatSweep) { lastChatSweep = now; swept = new Map() }
    else pruneActivity(now)
    if (topicSweep) {
      lastTopicSweep = now
      const window = { since: new Date(now - FEISHU_TIMING.topicSweep).toISOString(), until: new Date(now).toISOString() }
      for (const [chatId, direct] of Object.entries(chats)) {
        if (signal.aborted) break
        try { await sweepChatTopics(ctx, chatId, direct, window.since, window.until, signal, tally, 'all', cache, catchUp) }
        catch (error) { if (!signal.aborted) errors.push(`${chatId} topics: ${String(error)}`) }
      }
    }
    await pollThreads(ctx, signal, tally, cache)
    for (const chatId of failures.keys()) if (!(chatId in chats)) failures.delete(chatId)
    const skipped = tally.skipped ? `; ${tally.skipped} unreadable messages skipped` : ''
    const retrying = errors.length ? `; ${errors.length} chat(s) failed this round, retrying` : ''
    // The call count only moves enough to matter on a sweep round, so that is when it is worth reporting.
    const calls = larkCallStats().total - reportedCalls
    reportedCalls += calls
    const read = chatSweep ? `; ${calls} API calls since the last chat sweep` : ''
    if (!signal.aborted) ctx.report('history', historyFailureHealth(failures, errors) ?? {
      state: 'ready', detail: `Configured groups and known direct chats recovered${skipped}${retrying}${read}`, at: new Date().toISOString() })
    await delay(ROUND_MS, undefined, { signal }).catch(() => {})
  }
}

/** Sweeps one chat between its cursor and now, advancing the cursor only on success so a failed chat is retried. */
async function sweepChat(ctx: SourceContext, chatId: string, direct: boolean, signal: AbortSignal, tally: Tally,
  failures: Map<string, number>, errors: string[], topics: TopicMode, cache?: FeishuCache, force = false): Promise<void> {
  const started = new Date().toISOString()
  const cursorKey = KV.feishu.history(chatId)
  const since = ctx.state.get(cursorKey)
  if (since === undefined) { ctx.state.set(cursorKey, started); return }
  try {
    await backfillChat(ctx, chatId, direct, since, started, signal, tally, { topics, cache, force })
    if (!signal.aborted) ctx.state.set(cursorKey, cursorAt(started))
    failures.delete(chatId)
  } catch (error) {
    if (signal.aborted) return
    failures.set(chatId, (failures.get(chatId) ?? 0) + 1)
    errors.push(`${chatId}: ${String(error)}`)
  }
}

/** Which topics a sweep reads: every known one, only the recently active ones, or none (a chat-only pass). */
export type TopicMode = 'all' | 'hot' | 'none'
/**
 * What a sweep reads and shares with the rest of its round; both are optional so the exported functions stay usable alone.
 * `force` reads every topic whatever the recent window says, which is what a reconnect catch-up needs.
 */
export interface SweepOptions { topics?: TopicMode; cache?: FeishuCache; force?: boolean }

/**
 * Backfills chat messages and active topic replies between `since` and `until` before the caller advances the chat cursor.
 * Topics are stored as `{ id: lastSeenAt }`, and unsubscribed topics older than the polling horizon are pruned.
 */
export async function backfillChat(ctx: SourceContext, chatId: string, direct: boolean, since: string, until: string,
  signal: AbortSignal, tally: Tally = { skipped: 0 }, options: SweepOptions = {}): Promise<void> {
  const topics = { ...ctx.state.get(KV.feishu.topics(chatId)) }
  await scanContainer(ctx, chatId, direct, 'chat', chatId, since, until, signal, tally, topics, options.cache)
  // A quiet topic is forgotten unless a subscribed Thread that is still polled follows it.
  const followed = new Set(ctx.threads.subscribed(SOURCE).filter(thread => polled(ctx, thread))
    .map(thread => String(thread.meta.threadId ?? ctx.triggers.latest(thread.key)?.meta.threadId ?? '')))
  for (const [id, seen] of Object.entries(topics)) {
    if (!followed.has(id) && Date.parse(until) - Date.parse(seen) >= POLL_HORIZON_MS) delete topics[id]
  }
  ctx.state.set(KV.feishu.topics(chatId), topics)
  const mode = options.topics ?? 'all'
  if (mode !== 'none') await scanTopics(ctx, chatId, direct, topics, since, until, signal, tally, mode, options.cache, options.force)
}
/** Reads this chat's topics without reading the chat itself: the cold sweep, and the reconnect catch-up's topic half. */
export async function sweepChatTopics(ctx: SourceContext, chatId: string, direct: boolean, since: string, until: string,
  signal: AbortSignal, tally: Tally = { skipped: 0 }, mode: TopicMode = 'all', cache?: FeishuCache, force = false): Promise<void> {
  const topics = { ...ctx.state.get(KV.feishu.topics(chatId)) }
  await scanTopics(ctx, chatId, direct, topics, since, until, signal, tally, mode, cache, force)
  ctx.state.set(KV.feishu.topics(chatId), topics)
}
/**
 * Whether the topic pass still reads a topic: one that saw a message within `topicRecent`, or one whose stored time is
 * unreadable. The decision reads the persisted `lastSeenAt`, not the in-memory activity markers, because a restart
 * empties those and would otherwise skip every topic exactly when the catch-up has the most to recover.
 */
const recentTopic = (seen: string | undefined, now: number): boolean => {
  const at = Date.parse(seen ?? '')
  return !Number.isFinite(at) || now - at < FEISHU_TIMING.topicRecent
}
/**
 * Reads the chosen topics of one chat; a hot topic is one that received an event within `topicHot`, while the periodic
 * pass reads the topics that saw a message within `topicRecent` unless `force` asks for all of them.
 */
async function scanTopics(ctx: SourceContext, chatId: string, direct: boolean, topics: Record<string, string>,
  since: string, until: string, signal: AbortSignal, tally: Tally, mode: TopicMode, cache?: FeishuCache, force = false): Promise<void> {
  const ids = Object.keys(topics)
  const now = Date.now()
  const chosen = mode === 'hot' ? ids.filter(id => now - (activity.topic.get(id) ?? 0) < FEISHU_TIMING.topicHot)
    : mode === 'none' ? [] : ids.filter(id => force || recentTopic(topics[id], now))
  for (const id of chosen) {
    if (signal.aborted) return
    await scanContainer(ctx, chatId, direct, 'thread', id, since, until, signal, tally, topics, cache)
  }
}
/**
 * Whether a message read from history enters intake. Another app's broadcast that names nobody is dropped — it is the
 * bulk of what history recovers, and the Policy ignores it — while a message that addresses this bot, or comes from a
 * bot the Policy lists, still enters.
 */
export function admitsBackfill(ctx: SourceContext, trigger: Trigger): boolean {
  if (trigger.human || trigger.addressed || trigger.actor.id === '') return true
  return ctx.policyBots().some(bot => bot.id === trigger.actor.id)
}
async function scanContainer(ctx: SourceContext, chatId: string, direct: boolean, kind: 'chat' | 'thread', id: string,
  since: string, until: string, signal: AbortSignal, tally: Tally, topics: Record<string, string>, cache?: FeishuCache): Promise<void> {
  const commands = ctx.commands.withSignal(signal)
  const lark = <T>(args: string[]): Promise<T> => cache ? cache.lark<T>(commands, args) : commands.lark<T>(args)
  let page: string | undefined
  const pages = new Set<string>()
  do {
    if (signal.aborted) throw signal.reason
    const seconds = (time: string) => String(Math.floor(Date.parse(time) / 1000))
    const parameters = { container_id_type: kind, container_id: id, start_time: seconds(since), end_time: seconds(until),
      sort_type: 'ByCreateTimeAsc', page_size: 50, ...(page ? { page_token: page } : {}) }
    const request = ['api', 'GET', '/open-apis/im/v1/messages', '--params', JSON.stringify(parameters)]
    const result = HistoryPageSchema.parse(await lark(request))
    for (const message of validItems(HistoricalMessageSchema, result.items, tally)) {
      const outside = message.chat_id !== chatId || (kind === 'thread' && message.thread_id !== id)
      if (outside) throw new Error('Feishu history returned a message outside the requested chat or thread')
      if (message.deleted) continue
      const at = feishuTime(message.create_time)
      if (message.thread_id && !(Date.parse(topics[message.thread_id] ?? '') >= Date.parse(at))) topics[message.thread_id] = at
      const trigger = feishuTrigger(historyEvent(message, chatId, direct), bot(ctx).botId, bot(ctx).appId)
      if (trigger && admitsBackfill(ctx, trigger)) await receive(ctx, trigger)
    }
    const stuck = result.has_more && (!result.page_token || pages.has(result.page_token))
    if (stuck) throw new Error('Feishu history pagination did not advance')
    page = result.has_more ? result.page_token : undefined
    if (page) pages.add(page)
  } while (page)
}

/** Resolves the retained source message reference for polling a subscribed thread. */
export function threadRef(ctx: SourceContext, thread: Thread): FeishuRef | undefined {
  const meta = thread.meta as { sourceTriggerId?: string; chatId?: string; messageId?: string }
  if (meta.chatId && meta.messageId && meta.sourceTriggerId) {
    return { triggerId: meta.sourceTriggerId, chatId: meta.chatId, messageId: meta.messageId }
  }
  const trigger = ctx.triggers.latest(thread.key)
  return trigger ? feishuRef(trigger) : undefined
}
/**
 * Whether a subscribed thread is worth reading this round: a thread a live ticket follows is read at most every
 * `threadPoll`, and one nothing follows is only read while it saw activity within `threadRecent`. A thread that is quiet
 * and ticketless keeps its subscription but is left to the reconnect catch-up.
 */
export function threadDue(ctx: SourceContext, thread: Thread, now = Date.now()): boolean {
  if (now - (activity.thread.get(thread.key) ?? 0) < FEISHU_TIMING.threadPoll) return false
  const followed = thread.subscriptions.some(id => {
    const ticket = ctx.tickets.get(id)
    return !!ticket && liveTicket(ticket)
  })
  if (followed) return true
  return now - Date.parse(thread.lastAt ?? thread.createdAt) < FEISHU_TIMING.threadRecent
}
/** Polls subscribed Feishu threads that are due, so replies missed by the live stream become triggers for their tickets. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, tally?: Tally, cache?: FeishuCache): Promise<void> {
  const now = Date.now()
  await pollEach(ctx, SOURCE, () => !!signal?.aborted, thread => pollThread(ctx, thread, signal, tally, cache),
    thread => !threadDue(ctx, thread, now))
}
async function pollThread(ctx: SourceContext, thread: Thread, signal?: AbortSignal, tally?: Tally, cache?: FeishuCache): Promise<void> {
  const ref = threadRef(ctx, thread)
  if (!ref) throw new Error('Subscribed thread has no retained source message')
  const config = enabled(ctx)
  // The Source was turned off; the next round polls again.
  if (!config) return
  activity.thread.set(thread.key, Date.now())
  const commands = ctx.commands.withSignal(signal)
  // A thread's first page usually repeats a page the topic sweep of the same round already read; share that read.
  const reader: Pick<Commands, 'lark'> = cache ? { lark: (args, cwd) => cache.lark(commands, args, cwd) } : commands
  const pageSize = config.readPageSize
  const checkpoint = KV.feishu.seen(thread.key)
  const known = new Set(ctx.state.get(checkpoint) ?? [])
  const initialized = ctx.state.get(KV.feishu.initialized(thread.key))
  if (!initialized) {
    // Mark root and parent messages as seen on first poll so historical context is not ingested as new triggers.
    for (const section of ['root', 'parent']) {
      const result = await readFeishu(reader, ref, `feishu/${ref.triggerId}/${section}`, pageSize)
      if ('message' in result && result.message) known.add(result.message.message_id)
    }
    ctx.state.set(checkpoint, [...known])
  }
  const direct = ctx.state.get(KV.feishu.chats)?.[ref.chatId] === true
  const since = Date.parse(thread.createdAt)
  const root = thread.ref.id.slice(thread.ref.id.indexOf(':') + 1)
  let resource: string | null = `feishu/${ref.triggerId}/thread`
  while (resource) {
    if (signal?.aborted) return
    const result = await readFeishu(reader, ref, resource, pageSize, 'desc')
    if (!('messages' in result)) throw new Error('Expected Feishu thread messages')
    if (tally && 'skipped' in result) tally.skipped += result.skipped ?? 0
    if ('thread_id' in result && result.thread_id && thread.meta.threadId !== result.thread_id) {
      ctx.threads.patch(thread.key, { threadId: result.thread_id })
    }
    const encounteredKnown = result.messages.some(message => known.has(message.message_id))
    const { botId, appId } = bot(ctx)
    for (const message of result.messages.filter(item => !known.has(item.message_id) && !item.deleted).reverse()) {
      if (signal?.aborted) return
      const trigger = feishuTrigger(topicEvent(message, ref.chatId, direct, root), botId, appId)
      // Ignore messages older than the thread subscription on initial poll.
      if (!trigger || (!initialized && Date.parse(trigger.at) < since)) continue
      await receive(ctx, trigger)
    }
    result.messages.forEach(message => known.add(message.message_id))
    ctx.state.set(checkpoint, [...known])
    if (initialized && encounteredKnown) break
    resource = result.next_resource
  }
  ctx.state.set(KV.feishu.initialized(thread.key), true)
}
