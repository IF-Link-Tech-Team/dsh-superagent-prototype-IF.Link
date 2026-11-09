/** The emoji a took-up message wears, picked by a decision model from the emoji Feishu offers. */
import { expect, it, vi } from 'vitest'
import { MarkPicker } from '../src/app/marks.ts'
import type { OutboundMessage, Ticket, Trigger } from '../src/core/index.ts'
import { FEISHU_EMOJIS } from '../src/feishu-emojis.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

/** The mark the Engine queues for `trigger`, which the pick reads. */
const mark = (trigger: Trigger, ticket: Ticket): OutboundMessage => ({ id: 'mark-1', channel: trigger.channel!, text: '',
  kind: 'reaction', reaction: 'received', triggerId: trigger.id, ticketId: ticket.id })
/** A Workers AI answer, in the shape the pick reads. */
const answer = (emoji: string) => ({ success: true, result: { usage: { input_tokens: 3900 }, answers: {
  tone: { type: 'choice', choice: 'brisk', confidence: 0.7 },
  emoji: { type: 'choice', choice: emoji, confidence: 0.66 },
} } })
/** A picker over the Runtime's Store, with a stand-in Workers AI that records each request. */
function picker(h: Host, response: unknown, options: { reject?: Error; account?: string; token?: string } = {}) {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = []
  const fetch = vi.fn(async (url: string, init: { body: string; headers: Record<string, string> }) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown>, headers: init.headers })
    if (options.reject) throw options.reject
    return { json: async () => response }
  })
  const health = { state: 'ready', detail: '', set: vi.fn(), get: () => undefined, release: () => {} }
  const chooser = new MarkPicker({ store: h.runtime.store, health: health as never }, { account: options.account ?? 'acct',
    token: options.token ?? 'tok', fetch: fetch as unknown as typeof globalThis.fetch, timeoutMs: 1000 })
  return { chooser, calls, fetch, health }
}
/** A Ticket accepted from a person, and the mark the Engine queued for the message it came from. */
async function accepted(h: Host) {
  const { trigger, ticket } = await h.acceptedTicket(feishu('1', '帮我调研 decision 模型的渠道和价格，今天要给'))
  return mark(trigger, ticket)
}

it('reads the message, the Router judgement and the ticket, and answers the emoji the model picked', async () => {
  const h = await startRuntime()
  try {
    const chosen = picker(h, answer('Coffee'))
    expect(await chosen.chooser.pick(await accepted(h))).toEqual({ emoji: 'Coffee', tone: 'brisk', confidence: 0.66 })
    const [call] = chosen.calls
    expect(call!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef-flash')
    expect(call!.headers.Authorization).toBe('Bearer tok')
    const body = call!.body as { model: string; state: { message: { text: string }; ticket: { title: string }; router?: { decision: string } }
      questions: Record<string, { type: string; criteria: Record<string, string> }> }
    expect(body.model).toBe('clef-flash')
    // Every emoji Feishu has is a candidate, described in Chinese, so the pick is made among all of them.
    expect(Object.keys(body.questions.emoji!.criteria).sort()).toEqual(Object.keys(FEISHU_EMOJIS).sort())
    expect(body.questions.emoji!.type).toBe('choice')
    expect(body.state.message.text).toContain('调研')
    expect(body.state.ticket.title).toContain('Fix')
    expect(chosen.health.set).toHaveBeenCalledWith(expect.objectContaining({ state: 'ready', detail: expect.stringContaining('Coffee') }))
  } finally { await h.stop() }
})

it('keeps the Channel its own mark when the account is unset, the call fails, or the emoji is one Feishu does not have', async () => {
  const h = await startRuntime()
  try {
    const message = await accepted(h)
    // Both the account and its token are needed; without them nothing is asked.
    const off = picker(h, answer('Coffee'), { account: '', token: '' })
    expect(await off.chooser.pick(message)).toBeUndefined()
    expect(off.fetch).not.toHaveBeenCalled()
    // A failed call reports itself, and the mark is drawn by the Channel instead.
    const failed = picker(h, answer('Coffee'), { reject: new Error('boom') })
    expect(await failed.chooser.pick(message)).toBeUndefined()
    expect(failed.health.set).toHaveBeenCalledWith(expect.objectContaining({ state: 'error', detail: 'boom' }))
    // An answer the Channel cannot draw is refused rather than sent.
    const wrong = picker(h, answer('NotAnEmoji'))
    expect(await wrong.chooser.pick(message)).toBeUndefined()
    expect(wrong.health.set).toHaveBeenCalledWith(expect.objectContaining({ state: 'error', detail: expect.stringContaining('NotAnEmoji') }))
    // A mark that names no Trigger reads nothing.
    expect(await picker(h, answer('Coffee')).chooser.pick({ ...message, triggerId: undefined })).toBeUndefined()
  } finally { await h.stop() }
})
