/** Choosing which emoji a message wears, with a decision model that reads the message and the work around it. */
import { z } from 'zod'
import type { GestureIntent, OutboundMessage, Trigger } from '../core/index.ts'
import { FEISHU_EMOJIS, isFeishuEmoji } from '../feishu-emojis.ts'
import type { HealthEntry } from '../infra/health.ts'
import { threadKey } from '../core/index.ts'
import type { Store } from './store.ts'

/** The Cloudflare Workers AI account and token the pick needs; without both the pick is skipped and a Channel keeps its own mark. */
export interface MarkAccount { account: string; token: string }
export interface MarkPickerHost {
  readonly store: Pick<Store, 'triggers' | 'tickets' | 'decisions' | 'read'>
  readonly health: HealthEntry
}
/** What one pick answered: the emoji, the tone the model read, and how sure it was. */
export interface MarkPick { emoji: string; tone?: string; confidence?: number }
/** A model's pick over the emoji a Channel can draw, or undefined to leave the Channel its own. */
export interface MarkChooser { pick(message: OutboundMessage): Promise<MarkPick | undefined> }

/** One answer of one question: a choice, its probabilities and the model's confidence; `noul` and `score` answers differ. */
const Answer = z.object({ type: z.string(), choice: z.string().optional(), confidence: z.number().optional() })
/** Workers AI wraps the System One answer under `result`, with the model name and the tokens it read. */
const WorkersAIResponse = z.object({
  success: z.boolean(),
  result: z.object({ answers: z.record(z.string(), Answer), usage: z.object({ input_tokens: z.number() }).partial().optional() }).optional(),
  errors: z.array(z.object({ message: z.string() }).loose()).optional(),
})
/** The two questions asked together: the tone, for the record, and the emoji, which is the answer the Channel draws. */
const INSTRUCTIONS = [
  '这条消息要我们去做事。先判断它的语气，再从飞书表情里挑一个最贴切的贴上去，表示我们收到了、正在处理。',
  '优先挑有性格的（Fire 来劲、Coffee 长活、SALUTE 保证完成、FACEPLAM 无奈、SWEAT 有压力、LOL 好笑……），',
  '不要总是挑最保守的那一个；只有严肃或紧急的场合才退回 OnIt / OK。不要挑冒犯、暧昧、涉黄涉暴的。',
].join('')
/** The emoji a gesture intent may draw, so a celebration never picks a skull and a condolence never picks a party horn. */
const POOLS: Record<GestureIntent, readonly string[]> = {
  celebrate: ['PARTY', 'FIREWORKS', 'Trophy', 'YEAH', 'Fire', 'GIFT', 'CAKE'],
  applause: ['APPLAUSE', 'CLAP', 'PRAISE', 'HIGHFIVE', 'FISTBUMP', 'MUSCLE'],
  laugh: ['LOL', 'LAUGH', 'CHUCKLE', 'FACEPALM', 'SMIRK', 'TONGUE'],
  comfort: ['HUG', 'COMFORT', 'FINGERHEART', 'HEART', 'ROSE'],
  hype: ['GoGoGo', 'MUSCLE', 'STRIVE', 'YouAreTheBest', 'Fire', 'STRIVE'],
  respect: ['SALUTE', 'SaluteFace', 'FINGERHEART', 'THUMBSUP', 'HIGHFIVE'],
  surprise: ['WOW', 'SHOCKED', 'WHAT', 'SPEECHLESS', 'SWEAT'],
  tease: ['WINK', 'SMIRK', 'TEASE', 'TONGUE', 'ClownFace', 'LOL'],
  aww: ['LOVE', 'BLUSH', 'INNOCENTSMILE', 'FINGERHEART', 'ROSE'],
  ouch: ['SWEAT', 'SKULL', 'SPITBLOOD', 'TOASTED', 'FACEPALM', 'ColdSweat'],
  thanks: ['THANKS', 'ThanksFace', 'ROSE', 'FINGERHEART', 'BLUSH'],
  agree: ['FISTBUMP', 'JIAYI', 'Yes', 'CheckMark', 'THUMBSUP'],
}
/** How much of the message, the ticket and its history the pick reads; longer text is cut, since the pick needs the gist. */
const TEXT_CHARS = 600, TITLE_CHARS = 120, SCOPE_CHARS = 300, HISTORY = 5, HISTORY_CHARS = 120
/**
 * Marks picks one emoji for a message a Ticket took up, from the emoji Feishu can draw and a decision model's reading of the
 * message, the Router's judgement about it and the Thread it came from. The decision costs one request; a missing account,
 * a failed call or an answer the Channel cannot draw leaves the Channel its own mark, so the mark never waits on the model.
 */
export class MarkPicker implements MarkChooser {
  constructor(private readonly host: MarkPickerHost, private readonly options: MarkAccount & {
    model?: string; timeoutMs?: number; fetch?: typeof globalThis.fetch
  }) {}
  /** Whether the pick can run: both the account and its token are configured. */
  get configured(): boolean { return !!this.options.account && !!this.options.token }
  /**
   * Ask the model which emoji this message should wear.
   * @returns the emoji and what the model read, or undefined when the pick failed and the Channel should keep its own mark.
   */
  async pick(message: OutboundMessage): Promise<MarkPick | undefined> {
    if (!this.configured) return undefined
    const trigger = this.trigger(message)
    if (!trigger) return undefined
    const model = this.options.model ?? 'clef-flash'
    const body = { model, state: this.state(trigger, message), questions: this.questions(message.intent) }
    try {
      const response = await (this.options.fetch ?? globalThis.fetch)(this.url(model), {
        method: 'POST', headers: { Authorization: `Bearer ${this.options.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(this.options.timeoutMs ?? 4000),
      })
      const parsed = WorkersAIResponse.parse(await response.json())
      if (!parsed.success) throw new Error(parsed.errors?.map(error => error.message).join('; ') || 'Workers AI refused the pick')
      const answers = parsed.result?.answers ?? {}
      const emoji = answers.emoji?.choice
      // An answer the Channel cannot draw is no answer: the emoji ids are what `im.reactions.create` accepts, exactly.
      if (!emoji || !isFeishuEmoji(emoji)) throw new Error(`Workers AI picked an emoji Feishu does not have: ${String(emoji)}`)
      this.host.health.set({ state: 'ready', detail: `Picked ${emoji} for ${trigger.id}; ${parsed.result?.usage?.input_tokens ?? 0} tokens`,
        at: new Date().toISOString() })
      return { emoji, ...answers.tone?.choice ? { tone: answers.tone.choice } : {},
        ...answers.emoji?.confidence === undefined ? {} : { confidence: answers.emoji.confidence } }
    } catch (error) {
      // The mark is a courtesy: a failed pick reports itself and leaves the Channel's own mark, never retrying the model.
      this.host.health.set({ state: 'error', detail: String(error instanceof Error ? error.message : error), at: new Date().toISOString() })
      return undefined
    }
  }
  /** The Trigger of the message the mark is on, which the Engine recorded when it queued the mark. */
  private trigger(message: OutboundMessage): Trigger | undefined {
    return message.triggerId ? this.host.store.triggers.get(message.triggerId) : undefined
  }
  /** What the model reads: the message, the Router's judgement on it, the Ticket, and the Thread's last few messages. */
  private state(trigger: Trigger, message: OutboundMessage): Record<string, unknown> {
    const ticket = message.ticketId ? this.host.store.tickets.get(message.ticketId) : undefined
    const thread = threadKey(trigger.threads[0]!)
    const decision = this.host.store.decisions.byThread(thread).at(-1)
    const history = this.host.store.read.threadTriggers(thread, HISTORY)
      .map(item => `${item.human ? item.actor.id === trigger.actor.id ? '同一个人' : '别人' : '机器人'}：${cut(item.text, HISTORY_CHARS)}`)
    return {
      message: { text: cut(trigger.text, TEXT_CHARS), where: trigger.addressed === 'direct' ? '私聊' : '群聊', addressed: !!trigger.addressed },
      ...decision ? { router: { decision: decision.kind, reason: (decision.reason ?? []).map(reason => reason.code).join(', ') } } : {},
      ...ticket ? { ticket: { title: cut(ticket.title, TITLE_CHARS), scope: cut(ticket.mandate.scope, SCOPE_CHARS) } } : {},
      ...history.length > 1 ? { recent: history } : {},
    }
  }
  /** The two questions: the tone the model reads, and the emoji it picks from every one Feishu has. */
  private questions(intent?: GestureIntent): Record<string, unknown> {
    return {
      tone: { type: 'choice', instructions: '这条消息属于哪种语气？',
        criteria: { brisk: '普通请求，干净利落地开工', playful: '语气轻松、有玩笑', serious: '涉及钱、承诺、人事、事故',
          urgent: '催得急、今天就要', empathy: '对方在担心、抱怨、有情绪', thanks: '道谢、收尾' } },
      emoji: { type: 'choice', instructions: instructionsFor(intent),
        criteria: Object.fromEntries(candidateIds(intent).map(id => [id, FEISHU_EMOJIS[id]!.zh])) },
    }
  }
  private url(model: string): string {
    return `https://api.cloudflare.com/client/v4/accounts/${this.options.account}/ai/run/@cf/cloudflare/${model}`
  }
}
/** The emoji a gesture intent may draw; a mark with no intent is picked from everything Feishu has. */
const candidateIds = (intent?: GestureIntent): readonly string[] =>
  intent && POOLS[intent] ? POOLS[intent].filter(id => isFeishuEmoji(id)) : Object.keys(FEISHU_EMOJIS)
/** What the pick is asked for: a working mark, or the gesture the Router read. */
const instructionsFor = (intent?: GestureIntent): string => intent
  ? `这条消息不需要我们干活，但值得给一个反应。挑一个${intent}味最足的飞书表情贴上去，要像一个真同事顺手点的：贴切、可以俏皮，别冒犯。`
  : INSTRUCTIONS
/** Cuts text to `chars`, marking where it was cut, so one long message cannot crowd the pick's short question. */
const cut = (text: string, chars: number): string => text.length <= chars ? text : `${text.slice(0, chars)}…`
