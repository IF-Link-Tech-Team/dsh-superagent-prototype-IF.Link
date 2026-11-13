/**
 * ClawChat source: an agent-native chat app whose channel is a Protocol v2 WebSocket rather than a CLI, so reading a
 * message costs a frame on an already-open socket instead of an API call against a tenant quota.
 *
 * Pairing mints an identity from the owner's single-use code; after that the tokens in the KV store are the whole
 * credential, and a restart resumes from them without redeeming anything again.
 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import { record, family } from '../kv.ts'
import { ClawChatConnection, ClawChatError, checkConnectCode, deriveWsDeviceId, newRestDeviceId, redeemConnectCode,
  refreshTokens, type ClawChatIdentity, type ClawChatInbound } from './clawchat-protocol.ts'
import { sourceContext, type SourceContext } from './host.ts'

// The protocol layer is exported so its parts can be exercised without a live pairing.
export { ClawChatConnection, ClawChatError, checkConnectCode, chunkText, deriveWsDeviceId, jwtClaims, newMessageId, newRestDeviceId,
  redeemConnectCode, refreshTokens, renderFragments } from './clawchat-protocol.ts'
export type { ClawChatIdentity, ClawChatInbound } from './clawchat-protocol.ts'
import type { ChannelLink, SourceKind } from './kind.ts'
import type { SourceRegistry } from './registry.ts'

export const SOURCE = 'clawchat'
/** Agent REST calls name the host this way; the server only warns when it does not know the value. */
const PLATFORM = 'dsh'
/** How often the token check runs: a refresh happens once the access token is within half an hour of expiring. */
const REFRESH_CHECK_MS = 60_000
const REFRESH_AHEAD_MS = 30 * 60_000
/** The live connection, kept module-level because the Channel is given only commands, not the loop's socket. */
let live: ClawChatConnection | undefined
/** Marks whose reaction this Source falls back to when nothing chose one. */
const TAKEN_UP = '👀'
const FINISHED = '✅'

const KV = {
  identity: record<ClawChatIdentity>('clawchat-identity'),
}

const ClawChatConfigSchema = z.object({
  /** The owner's single-use pairing code; after the first pairing it is ignored and the stored tokens are used. */
  connectCode: z.string().trim().max(32).default(''),
  /** `all` reads every message in a group and lets the assessment decide; `mention` reads only what addresses the agent. */
  replyMode: z.enum(['all', 'mention']).default('mention'),
}).strict()
export type ClawChatConfig = z.infer<typeof ClawChatConfigSchema>

/** The deterministic Trigger id of one ClawChat message, so a reconnect replay cannot add it twice. */
export const clawchatTriggerId = (messageId: string): string => key('clawchat', messageId)

/** Builds the Trigger an inbound message becomes: its thread is the conversation, and a direct chat or a mention addresses it. */
export function clawchatTrigger(inbound: ClawChatInbound): Trigger {
  const direct = inbound.chatType === 'direct'
  return { id: clawchatTriggerId(inbound.messageId), source: SOURCE,
    threads: [{ source: SOURCE, id: `${SOURCE}:${inbound.chatId}` }],
    actor: { source: SOURCE, id: inbound.senderId }, human: true,
    ...(direct ? { addressed: 'direct' as const } : inbound.addressed ? { addressed: 'mention' as const } : {}),
    at: new Date(inbound.emittedAt).toISOString(), text: inbound.text,
    channel: { source: SOURCE, thread: `${SOURCE}:${inbound.chatId}`,
      address: { chatId: inbound.chatId, messageId: inbound.messageId, ...(direct ? { direct: 'true' } : {}) } },
    meta: { chatId: inbound.chatId, messageId: inbound.messageId, direct, mentioned: inbound.addressed,
      ...(inbound.replyTo ? { parentId: inbound.replyTo } : {}) } }
}

/** Replies through the live socket; a closed socket throws so the outbox retries once the channel is back. */
export async function sendClawChat(message: OutboundMessage): Promise<'sent' | 'gone'> {
  const chatId = message.channel.address.chatId
  if (!chatId) throw new Error('Missing ClawChat conversation')
  if (!live) throw new Error('ClawChat is not connected')
  const replyTo = message.channel.address.messageId
  try { await live.send(chatId, message.text, replyTo ? { replyTo } : {}) }
  catch (error) {
    // A conversation the owner dissolved can never receive a reply again; everything else is worth retrying.
    if (error instanceof ClawChatError && /dissolved/i.test(error.message)) return 'gone'
    throw error
  }
  return 'sent'
}

/** Draws a mark on a message; ClawChat reactions carry no idempotency key, so a repeat just sets the same emoji. */
export function reactClawChat(message: OutboundMessage): 'sent' | 'gone' {
  const chatId = message.channel.address.chatId
  const messageId = message.channel.address.messageId
  if (!chatId || !messageId || !live) return 'gone'
  live.react(chatId, messageId, message.emoji ?? (message.reaction === 'finished' ? FINISHED : TAKEN_UP))
  return 'sent'
}

export const clawchatKind: SourceKind<ClawChatConfig> = {
  kind: SOURCE,
  title: { zh: 'ClawChat', en: 'ClawChat' },
  description: { zh: 'Agent 原生的聊天应用：用长连接收发消息，不占飞书等平台的 API 额度。',
    en: 'An agent-native chat app: messages arrive over a long connection and spend no platform API quota.' },
  schema: ClawChatConfigSchema,
  fields: [
    { key: 'connectCode', type: 'text', label: { zh: '配对码', en: 'Connect code' },
      hint: { zh: '在 ClawChat 应用里给这个 Agent 生成的 8 位邀请码，两小时内有效、只能用一次。配对成功后留空即可，凭据存在本地状态里。',
        en: 'The 8-character invite code from the ClawChat app for this agent; valid for two hours and single-use. Leave it empty after pairing: the credentials live in the local state.' } },
    { key: 'replyMode', type: 'select', label: { zh: '接收', en: 'Receive' },
      options: [{ value: 'mention', label: { zh: '仅 @ 我', en: 'Only what addresses me' } },
        { value: 'all', label: { zh: '全部消息', en: 'All messages' } }],
      hint: { zh: '“仅 @ 我”只把 @ 这个 Agent 的消息和私聊交给研判；“全部消息”把群里每句话都交过去，由评估按规则决定要不要接。',
        en: '"Only what addresses me" hands assessments the messages that mention this agent plus direct chats; "All messages" hands over every group message and lets the assessment decide.' } },
  ],
  health: ['clawchat'],
  scope({ meta }, config) {
    if (meta.direct === true) return { listened: true, observed: false, row: 'direct' }
    return { listened: true, observed: config.replyMode === 'all', row: 'other' }
  },
  channel: {
    send: (_host, message) => sendClawChat(message),
    react: (_host, message) => Promise.resolve(reactClawChat(message)),
    // ClawChat has no web deep link that survives outside its app, so the Thread shows the conversation id.
    link: (address): ChannelLink => ({ url: '', label: { zh: `ClawChat ${address.chatId ?? ''}`, en: `ClawChat ${address.chatId ?? ''}` } }),
  },
}

/** Runs the channel until the signal aborts: pair when needed, then keep one connection up and hand inbound to the Engine. */
async function runClawChat(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  const enabled = (): ClawChatConfig | undefined => ctx.config<ClawChatConfig>(SOURCE)
  const config = enabled()
  if (!config) { ctx.report('clawchat', { state: 'paused', detail: 'Off' }); return }
  let identity = ctx.state.get(KV.identity)
  if (!identity) {
    const code = config.connectCode || process.env.CLAW_CONNECT_CODE || ''
    if (!code) {
      ctx.report('clawchat', { state: 'paused', detail: 'Waiting for a connect code from the ClawChat app' })
      return
    }
    try {
      const restDeviceId = newRestDeviceId()
      const check = await checkConnectCode(code, PLATFORM, restDeviceId, signal)
      if (!check.pairable) {
        ctx.report('clawchat', { state: 'error', detail: `The connect code is ${check.status}; ask for a fresh one` })
        return
      }
      identity = await redeemConnectCode(code, PLATFORM, restDeviceId, undefined, signal)
      identity.wsDeviceId = deriveWsDeviceId(identity)
      ctx.state.set(KV.identity, identity)
      ctx.report('clawchat', { state: 'ready', detail: `Paired as ${identity.nickname ?? identity.agentId}` })
    } catch (error) {
      ctx.report('clawchat', { state: 'error', detail: `Pairing failed: ${String(error).slice(0, 200)}` })
      return
    }
  }
  // `identity` is set: the store had one, or the pairing above just wrote it.
  let current: ClawChatIdentity = identity
  const connection = new ClawChatConnection(current, {
    onInbound: (inbound) => {
      if (!inbound.messageId || !inbound.chatId) return
      // A group only reaches the assessment when the reply mode admits unaddressed messages.
      if (inbound.chatType === 'group' && !inbound.addressed && enabled()?.replyMode !== 'all') return
      void ctx.receive(clawchatTrigger(inbound))
    },
    onIdentity: (next) => { current = next; ctx.state.set(KV.identity, next) },
    onHealth: (state, detail) => ctx.report('clawchat', { state, detail }),
    log: { info: (message) => console.log(`[clawchat] ${message}`), warn: (message) => console.warn(`[clawchat] ${message}`) },
  })
  live = connection
  // Tokens are single-use and rotate on every refresh, so the refresh runs before expiry and never in parallel.
  let refreshing = false
  const timer = setInterval(() => {
    if (refreshing || signal.aborted) return
    const expiresAt = current.expiresAt
    if (!expiresAt || expiresAt - Date.now() > REFRESH_AHEAD_MS) return
    refreshing = true
    refreshTokens(current, signal)
      .then((next) => { current = next; ctx.state.set(KV.identity, next); connection.setIdentity(next) })
      .catch((error: unknown) => ctx.report('clawchat', { state: 'error', detail: `Token refresh failed: ${String(error).slice(0, 160)}` }))
      .finally(() => { refreshing = false })
  }, REFRESH_CHECK_MS)
  timer.unref?.()
  try { await connection.run(signal) }
  finally { clearInterval(timer); connection.stop(); live = undefined }
}

export const name = 'dsh-superagent-clawchat'
export const inject = ['orchestrator']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(clawchatKind), 'clawchat: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runClawChat(sourceContext(ctx.orchestrator, clawchatKind), controller.signal)
    return async () => { controller.abort(); await running }
  })
}
