/**
 * ClawChat agent-side protocol: invite redemption, token refresh, and the Protocol v2 WebSocket.
 *
 * The wire contract is https://plugin.clawling.chat/clawchat/agent-protocol.md. Everything here is one channel's
 * half of it: pairing, the socket, inbound filtering, and sending. What the host does with an inbound message is
 * the Source's business, not this file's.
 *
 * Two device ids exist and must not be conflated: the REST constant (`X-Device-Id`, byte-identical across connect
 * and refresh, or the server answers 10003) and the per-install WebSocket id derived from the identity. Both are
 * persisted before they are first used, because a replays of a paired code is only accepted from the same one.
 */
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'

/** Production REST and WebSocket endpoints; the protocol forbids hardcoding them anywhere else. */
export const CLAWCHAT_REST = 'https://app.clawling.com'
export const CLAWCHAT_WS = 'wss://app.clawling.com/ws'
/** Sent as `connect.payload.client_version`; the server does not enforce it. */
export const CLAWCHAT_CLIENT_VERSION = 'dsh-superagent-1'
/** `connect.payload.protocol_version` is a NUMBER; the string `"2"` makes the server answer `hello-fail`. */
const PROTOCOL_VERSION = 2
const CAPABILITIES = { multi_device: false, device_replay: true, chat_meta_events: true, notify_signals: true, permission_events: true }
const HANDSHAKE_TIMEOUT_MS = 15_000
const PING_INTERVAL_MS = 20_000
const PONG_TIMEOUT_MS = 10_000
const ACK_TIMEOUT_MS = 15_000
const REST_TIMEOUT_MS = 15_000
const BACKOFF_BASE_MS = 500
const BACKOFF_CAP_MS = 15_000
/** Longest message the server accepts in one frame; longer text is split on this boundary. */
const CHUNK_CHARS = 4000

/** What the channel persists: everything needed to reconnect without the invite code. */
export interface ClawChatIdentity {
  /** The agent's own shadow user id (the JWT `sub`), which is what self-echo is compared against. */
  userId: string
  agentId: string
  ownerId: string
  /** The direct conversation with the owner: the only correct `chat_id` for a proactive message. */
  conversationId: string
  accessToken: string
  refreshToken: string
  /** REST `X-Device-Id`: one constant for this channel, minted once and never regenerated. */
  restDeviceId: string
  /** WebSocket device id from `hello-ok`, reused on every later connection to avoid a full inbox replay. */
  wsDeviceId?: string
  /** Access-token expiry, epoch ms, read from the JWT locally. */
  expiresAt?: number
  nickname?: string
  /** The owner-written system prompt delivered with the pairing. */
  behavior?: string
}

/** One inbound chat message, already filtered and rendered the way the host should read it. */
export interface ClawChatInbound {
  messageId: string
  chatId: string
  chatType: 'direct' | 'group'
  senderId: string
  senderName: string
  text: string
  /** True when the message addresses this agent: a direct chat, a mention of it, or `@所有人`. */
  addressed: boolean
  replyTo?: string
  emittedAt: number
}

export interface ClawChatLogger { info(message: string): void; warn(message: string): void }

/** Raised for a refusal the server explains with a `{code,msg,data}` envelope; `data` carries hints and timings. */
export class ClawChatError extends Error {
  constructor(readonly code: number, message: string, readonly data: Record<string, unknown> = {}) { super(message) }
  /** `true` when re-running the same call could succeed later. */
  get transient(): boolean { return this.code === 16025 || this.code === 1 }
}

interface Envelope { code: number; msg: string; data: Record<string, unknown> }

/** Sends one `/v1` call and unwraps the envelope: `code === 0` is the only success signal, whatever the HTTP status. */
async function call(path: string, body: Record<string, unknown>, options: { token?: string; deviceId: string; signal?: AbortSignal }): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-device-id': options.deviceId }
  if (options.token) headers.authorization = `Bearer ${options.token}`
  const response = await fetch(`${CLAWCHAT_REST}${path}`, { method: 'POST', headers, signal: options.signal,
    body: JSON.stringify(body) })
  let envelope: Envelope
  try { envelope = await response.json() as Envelope }
  catch { throw new ClawChatError(-1, `ClawChat ${path} answered ${response.status} without a JSON envelope`) }
  // 401/403 short-circuit to an auth error before the business code is read, so a refresh can be driven by the caller.
  if (envelope.code !== 0) throw new ClawChatError(envelope.code, `ClawChat ${path}: ${envelope.msg || 'failed'}`, envelope.data ?? {})
  return envelope.data ?? {}
}

/** Mints the one REST device id for this channel: stable per installation, never regenerated as part of a retry. */
export function newRestDeviceId(): string {
  return `dsh-superagent-${createHash('sha256').update(`${hostname()}\0${Date.now()}\0${Math.random()}`).digest('hex').slice(0, 24)}`
}

/** Derives the WebSocket device id from the identity, so a lost state file can recover it instead of becoming a new device. */
export function deriveWsDeviceId(identity: Pick<ClawChatIdentity, 'userId' | 'ownerId'>): string {
  const digest = createHash('sha256').update(`dsh-superagent\0${identity.ownerId}\0${identity.userId}\0${hostname()}`).digest('hex')
  return `dsh-superagent-${digest.slice(0, 24)}`
}

/** Reads a JWT's claims locally. Never verifies the signature: the server does that. */
export function jwtClaims(token: string): { sub?: string; oid?: string; aid?: string; exp?: number } {
  const parts = String(token ?? '').split('.')
  if (parts.length < 2) return {}
  try { return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { sub?: string; oid?: string; aid?: string; exp?: number } }
  catch { return {} }
}

/** Checks a code without consuming it; `status` is `pending` while the code is still redeemable. */
export async function checkConnectCode(code: string, platform: string, deviceId: string, signal?: AbortSignal): Promise<{ pairable: boolean; status: string }> {
  const data = await call('/v1/agents/connect/check', { code, platform }, { deviceId, signal })
  return { pairable: data.pairable === true, status: String(data.status ?? 'invalid') }
}

/**
 * Redeems an invite code for an identity. Omitting `userId` mints a brand-new agent, so a re-pair must pass the
 * stored one; the caller decides which of those it is.
 */
export async function redeemConnectCode(code: string, platform: string, deviceId: string, userId?: string, signal?: AbortSignal): Promise<ClawChatIdentity> {
  const body: Record<string, unknown> = { code, platform, type: 'clawbot', plugin_version: CLAWCHAT_CLIENT_VERSION }
  if (userId) body.user_id = userId
  const data = await call('/v1/agents/connect', body, { deviceId, signal })
  const agent = (data.agent ?? {}) as Record<string, unknown>
  const conversation = (data.conversation ?? {}) as Record<string, unknown>
  const accessToken = String(data.access_token ?? ''), refreshToken = String(data.refresh_token ?? '')
  if (!accessToken || !refreshToken) throw new ClawChatError(-1, 'ClawChat pairing answered without tokens')
  // The JWT's `sub` is authoritative for self-echo; a configured id that disagrees silently breaks it.
  const claims = jwtClaims(accessToken)
  const userId_ = String(claims.sub ?? agent.user_id ?? '')
  if (!userId_) throw new ClawChatError(-1, 'ClawChat pairing answered without the agent user id')
  return { userId: userId_, agentId: String(agent.id ?? claims.aid ?? ''), ownerId: String(agent.owner_id ?? claims.oid ?? ''),
    conversationId: String(conversation.id ?? ''), accessToken, refreshToken, restDeviceId: deviceId,
    expiresAt: typeof claims.exp === 'number' ? claims.exp * 1000 : undefined,
    ...(typeof agent.nickname === 'string' ? { nickname: agent.nickname } : {}),
    ...(typeof agent.behavior === 'string' ? { behavior: agent.behavior } : {}) }
}

/** Rotates both tokens (they are single-use): the caller must persist the result before swapping it in. */
export async function refreshTokens(identity: ClawChatIdentity, signal?: AbortSignal): Promise<ClawChatIdentity> {
  const data = await call('/v1/auth/refresh', { refresh_token: identity.refreshToken }, { deviceId: identity.restDeviceId, signal })
  const accessToken = String(data.access_token ?? ''), refreshToken = String(data.refresh_token ?? '')
  if (!accessToken || !refreshToken) throw new ClawChatError(-1, 'ClawChat refresh answered without tokens')
  const claims = jwtClaims(accessToken)
  return { ...identity, accessToken, refreshToken, expiresAt: typeof claims.exp === 'number' ? claims.exp * 1000 : undefined }
}

/** Crockford base32, the alphabet the server accepts in `msg-` ids. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** Mints a message id: `msg-` plus a 26-character ULID (10 of timestamp, 16 random), as the protocol requires. */
export function newMessageId(): string {
  let time = Date.now()
  let head = ''
  for (let index = 0; index < 10; index++) { head = CROCKFORD[time % 32]! + head; time = Math.floor(time / 32) }
  let tail = ''
  for (let index = 0; index < 16; index++) tail += CROCKFORD[Math.floor(Math.random() * 32)]
  return `msg-${head}${tail}`
}

/** Splits text on the protocol's chunk boundary, closing and reopening a fenced block so each part renders. */
export function chunkText(text: string, limit = CHUNK_CHARS): string[] {
  if (text.length <= limit) return [text]
  const parts: string[] = []
  let rest = text
  let fence: string | undefined
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit / 2) cut = limit
    let piece = rest.slice(0, cut)
    rest = rest.slice(cut)
    if (fence) piece = '```\n' + piece
    if (fence) rest = fence + '\n' + rest
    if ((countFences(piece) % 2) === 1) { piece += '\n```'; rest = '```\n' + rest; fence = '```' }
    else fence = undefined
    parts.push(piece)
  }
  parts.push(rest)
  return parts
}
const countFences = (text: string): number => (text.match(/^```/gm) ?? []).length

/** Renders inbound fragments the way the host should read them: text verbatim, mentions as `@name`, media as its name. */
export function renderFragments(fragments: unknown[]): string {
  let text = ''
  for (const fragment of fragments) {
    if (!fragment || typeof fragment !== 'object') continue
    const item = fragment as Record<string, unknown>
    const kind = item.kind
    if (kind === 'text') text += String(item.text ?? '')
    else if (kind === 'mention') text += `@${String(item.display ?? item.user_id ?? '')}`
    else if (kind === 'image') text += `!**${String(item.name ?? 'image')}**`
    else if (typeof item.name === 'string') text += `**${item.name}**`
  }
  return text.trim()
}

/** The mention ids of one message, merged from the body fragments and the message context as the protocol requires. */
function mentionIds(payload: Record<string, unknown>): string[] {
  const ids: string[] = []
  const message = (payload.message ?? {}) as Record<string, unknown>
  const body = (message.body ?? {}) as Record<string, unknown>
  const context = (message.context ?? {}) as Record<string, unknown>
  for (const list of [body.fragments, context.mentions]) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      if (record.kind !== undefined && record.kind !== 'mention') continue
      const id = record.user_id ?? record.userId ?? record.id
      if (typeof id === 'string' && id) ids.push(id)
    }
  }
  return ids
}

/** One live connection: the socket, its heartbeat, and pending acknowledgements keyed by `trace_id`. */
export class ClawChatConnection {
  private socket: WebSocket | undefined
  private pingTimer: NodeJS.Timeout | undefined
  private pongTimer: NodeJS.Timeout | undefined
  private backoff = 0
  private attempt = 1
  private closed = false
  private readyAt = 0
  private readonly acks = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private seq = 0

  constructor(private identity: ClawChatIdentity, private readonly handlers: {
    onInbound: (message: ClawChatInbound) => void
    onIdentity: (identity: ClawChatIdentity) => void
    onHealth: (state: 'starting' | 'ready' | 'error', detail: string) => void
    log: ClawChatLogger
  }) {}

  /** Replaces the tokens after a refresh; the caller reconnects to make the socket use them. */
  setIdentity(identity: ClawChatIdentity): void { this.identity = identity }

  /** Opens one connection and keeps it open until `stop()`: the handshake, the heartbeat and every later reconnect. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try { await this.connect(signal) }
      catch (error) {
        if (signal.aborted) break
        this.handlers.onHealth('error', String(error).slice(0, 300))
        this.handlers.log.warn(`clawchat: ${String(error).slice(0, 200)}`)
      }
      if (signal.aborted || this.closed) break
      await this.wait(this.nextDelay())
    }
  }

  /** Closes for good: a protocol-level stop, not a reconnect. */
  stop(): void {
    this.closed = true
    this.clearTimers()
    try { this.socket?.close(1000, 'client close') } catch { /* an already-closed socket needs no close */ }
    this.socket = undefined
    for (const ack of this.acks.values()) ack.reject(new Error('ClawChat connection closed'))
    this.acks.clear()
  }

  /** Sends one message to a conversation and waits for its ack; throws when the server refuses or the wait expires. */
  async send(chatId: string, text: string, options: { replyTo?: string } = {}): Promise<void> {
    for (const part of chunkText(text)) {
      const message: Record<string, unknown> = { message_id: newMessageId(), message_mode: 'normal',
        message: { body: { fragments: [{ kind: 'text', text: part }] },
          context: { mentions: [], reply: options.replyTo ? { reply_to_msg_id: options.replyTo, reply_preview: null } : null } } }
      const ack = await this.request(options.replyTo ? 'message.reply' : 'message.send', chatId, message)
      if (ack !== undefined && !ack) throw new Error('ClawChat refused the message')
    }
  }

  /** Adds an emoji reaction; fire-and-forget, no ack per the protocol. */
  react(chatId: string, targetMessageId: string, emoji: string): void {
    this.write('message.reaction', { chatId, payload: { target_message_id: targetMessageId, emoji, removed: false } })
  }

  /** Sends one frame and waits for its `message.ack`; `undefined` when no socket is open. */
  private request(event: string, chatId: string, payload: unknown): Promise<unknown> {
    const socket = this.socket
    if (!socket || socket.readyState !== 1) return Promise.reject(new Error('ClawChat is not connected'))
    const traceId = this.traceId(event)
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.acks.delete(traceId); reject(new Error('ClawChat ack timed out')) }, ACK_TIMEOUT_MS)
      this.acks.set(traceId, { resolve: (value) => { clearTimeout(timer); resolve(value) }, reject: (error) => { clearTimeout(timer); reject(error) } })
      socket.send(JSON.stringify({ version: '2', event, trace_id: traceId, emitted_at: Date.now(), chat_id: chatId, payload }))
    })
  }

  private write(event: string, body: { chatId: string; payload: unknown }): void {
    const socket = this.socket
    if (!socket || socket.readyState !== 1) return
    socket.send(JSON.stringify({ version: '2', event, trace_id: this.traceId(event), emitted_at: Date.now(), chat_id: body.chatId, payload: body.payload }))
  }

  private traceId(kind: string): string { this.seq += 1; return `dsh-${kind}-${String(this.seq).padStart(6, '0')}` }

  /** One socket's whole life: handshake, then frames until it closes. */
  private connect(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(CLAWCHAT_WS)
      this.socket = socket
      let settled = false
      const handshake = setTimeout(() => { if (!settled) { settled = true; this.closeSocket(); reject(new Error('ClawChat handshake timed out')) } }, HANDSHAKE_TIMEOUT_MS)
      const fail = (error: Error): void => { if (settled) return; settled = true; clearTimeout(handshake); reject(error) }
      const done = (): void => { if (settled) return; settled = true; clearTimeout(handshake); this.backoff = 0; this.attempt = 1; resolve() }
      socket.addEventListener('open', () => this.handlers.log.info('clawchat: socket open'))
      socket.addEventListener('error', () => fail(new Error('ClawChat socket error')))
      socket.addEventListener('close', (event) => {
        this.clearTimers()
        if (!settled) fail(new Error(`ClawChat socket closed before the handshake (${event.code})`))
        else if (!this.closed) { this.handlers.onHealth('error', `socket closed (${event.code})`); resolve() }
        else resolve()
      })
      socket.addEventListener('message', (event) => {
        let frame: Record<string, unknown>
        try { frame = JSON.parse(String(event.data)) as Record<string, unknown> }
        catch { return }
        if (frame.version !== '2') return
        const name = String(frame.event ?? '')
        if (name === 'connect.challenge') {
          const nonce = String(((frame.payload ?? {}) as Record<string, unknown>).nonce ?? '')
          const trace = this.traceId('connect')
          socket.send(JSON.stringify({ version: '2', event: 'connect', trace_id: trace, emitted_at: Date.now(),
            payload: { token: this.identity.accessToken, nonce, device_id: this.identity.wsDeviceId ?? deriveWsDeviceId(this.identity),
              client_version: CLAWCHAT_CLIENT_VERSION, protocol_version: PROTOCOL_VERSION, capabilities: CAPABILITIES } }))
          return
        }
        if (name === 'hello-ok') {
          const payload = (frame.payload ?? {}) as Record<string, unknown>
          const echoed = typeof payload.device_id === 'string' && payload.device_id ? payload.device_id : undefined
          if (echoed && echoed !== this.identity.wsDeviceId) this.handlers.onIdentity({ ...this.identity, wsDeviceId: echoed })
          this.backoff = 0; this.attempt = 1; this.readyAt = Date.now()
          this.handlers.onHealth('ready', 'Connected to ClawChat')
          this.startHeartbeat()
          done()
          return
        }
        if (name === 'hello-fail') {
          const reason = String(((frame.payload ?? {}) as Record<string, unknown>).reason ?? 'unknown')
          // Only this exact reason is terminal: every other one backs off with the same token.
          if (reason === 'authentication failed') { this.closed = true; this.handlers.onHealth('error', 'ClawChat authentication failed') }
          fail(new Error(`ClawChat handshake refused: ${reason}`))
          return
        }
        this.handleFrame(name, frame)
      })
      signal.addEventListener('abort', () => { this.stop(); resolve() }, { once: true })
    })
  }

  /** Dispatches one post-handshake frame: acks first, then inbound messages. */
  private handleFrame(name: string, frame: Record<string, unknown>): void {
    if (name === 'pong' || name === 'ping') {
      if (name === 'ping') {
        // The reply must echo emitted_at verbatim; re-stamping it makes the server drop the pong.
        const socket = this.socket
        if (socket?.readyState === 1) socket.send(JSON.stringify({ version: '2', event: 'pong', trace_id: frame.trace_id,
          emitted_at: frame.emitted_at, payload: {} }))
      } else this.clearPongTimer()
      return
    }
    if (name === 'message.ack' || name === 'message.error') {
      const ack = this.acks.get(String(frame.trace_id ?? ''))
      if (!ack) return
      this.acks.delete(String(frame.trace_id ?? ''))
      if (name === 'message.ack') ack.resolve(true)
      else ack.reject(new Error(`ClawChat rejected the message: ${String(((frame.payload ?? {}) as Record<string, unknown>).reason ?? 'refused')}`))
      return
    }
    if (name !== 'message.send' && name !== 'message.reply') return
    const payload = (frame.payload ?? {}) as Record<string, unknown>
    const chatId = String(frame.chat_id ?? '')
    const chatType = frame.chat_type === 'group' ? 'group' : 'direct'
    const sender = (frame.sender ?? {}) as Record<string, unknown>
    const senderId = String(sender.id ?? '')
    const message = (payload.message ?? {}) as Record<string, unknown>
    const body = (message.body ?? {}) as Record<string, unknown>
    const fragments = Array.isArray(body.fragments) ? body.fragments as unknown[] : []
    const mode = payload.message_mode
    // `""` means normal: the server does not fill the field in on the downlink.
    if (mode !== undefined && mode !== '' && mode !== 'normal') return
    // Unknown own id fails closed, or a self-echo loops back through the assistant.
    if (!this.identity.userId || !senderId) return
    if (senderId === 'system' || senderId === this.identity.userId) return
    const text = renderFragments(fragments)
    if (!text) return
    const mentioned = mentionIds(payload)
    // `@所有人` arrives as the literal sentinel `all` and counts as addressing this agent.
    const addressed = chatType === 'direct' || mentioned.includes(this.identity.userId) || mentioned.includes('all')
    const context = (message.context ?? {}) as Record<string, unknown>
    const reply = (context.reply ?? undefined) as Record<string, unknown> | undefined
    this.handlers.onInbound({ messageId: String(payload.message_id ?? ''), chatId, chatType, senderId,
      senderName: String(sender.nick_name ?? senderId), text, addressed,
      ...(reply && typeof reply.reply_to_msg_id === 'string' ? { replyTo: reply.reply_to_msg_id } : {}),
      emittedAt: typeof frame.emitted_at === 'number' ? frame.emitted_at : Date.now() })
  }

  private startHeartbeat(): void {
    this.clearTimers()
    this.pingTimer = setInterval(() => {
      const socket = this.socket
      if (socket?.readyState !== 1) return
      socket.send(JSON.stringify({ version: '2', event: 'ping', trace_id: this.traceId('ping'), emitted_at: Date.now(), payload: {} }))
      this.pongTimer = setTimeout(() => {
        // No pong in time: close and let the outer loop back off. WHATWG sockets offer no abort, so this is the only lever.
        this.handlers.onHealth('error', 'ClawChat heartbeat timed out')
        this.closeSocket()
      }, PONG_TIMEOUT_MS)
    }, PING_INTERVAL_MS)
    this.pingTimer.unref?.()
  }

  private clearPongTimer(): void { if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = undefined } }
  private clearTimers(): void { this.clearPongTimer(); if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = undefined } }
  private closeSocket(): void { this.clearTimers(); try { this.socket?.close(4000, 'heartbeat timeout') } catch { /* ignore */ } this.socket = undefined }

  /** Exponential backoff with jitter; the counter resets only after a connection stayed up a while. */
  private nextDelay(): number {
    if (this.readyAt && Date.now() - this.readyAt > 5000) this.attempt = 1
    const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (this.attempt - 1))
    this.attempt += 1
    return Math.round(base + Math.random() * base * 0.3)
  }

  private wait(ms: number): Promise<void> { return new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() }) }
}
