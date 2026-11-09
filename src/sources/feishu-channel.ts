/** Feishu outbound channel: posts threaded bot replies, marks messages with emoji reactions, and constructs chat deep links. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { feishuTriggerId } from './feishu-trigger.ts'

/** The emoji a message wears while its ticket works on it, and the one it wears once that work is done. */
const TAKEN_UP = 'OnIt'
const FINISHED = 'DONE'
/** Feishu or Lark AppLink that opens a chat; used when the message's own link was not delivered with the event. */
export const feishuChatLink = (brand: 'feishu' | 'lark', chatId: string): string =>
  `https://applink.${brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`
/**
 * True when Feishu permanently rejects a reply because the target message was recalled, withdrawn, or not found.
 * Only a Feishu response carrying one of these error codes means the target message is gone; timeouts or crashes do not.
 */
const gone = (error: unknown): boolean => error instanceof CliError && error.code !== undefined && (error.code === 230011
  || /withdrawn/i.test(error.message) || (Math.floor(error.code / 100) === 2300 && /not found/i.test(error.message)))
/** Replies in the topic of the target message; Feishu keeps at most one reply per idempotency key (the outgoing message's `message.id`). */
export async function sendFeishu(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const messageId = message.channel.address.messageId
  if (!messageId) throw new Error('Missing Feishu reply target')
  const text = checkedImText(message.text)
  const reply = ['im', '+messages-reply', '--message-id', messageId, '--markdown', text, '--reply-in-thread', '--idempotency-key', message.id]
  try { await host.commands.lark(reply) }
  catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
  return 'sent'
}
/** One page of a message's reaction records; callers read the operator to find the bot's own marks. */
const ReactionPage = z.object({
  items: z.array(z.object({ reaction_id: z.string(), operator: z.looseObject({ operator_type: z.string() }),
    reaction_type: z.object({ emoji_type: z.string() }) })),
  has_more: z.boolean().default(false),
  page_token: z.string().optional(),
})
/** Adds one emoji to a message as the bot; Feishu keeps one record per operator and emoji, so a repeated call changes nothing. */
async function addMark(host: Pick<SourceContext, 'commands'>, messageId: string, emoji: string): Promise<void> {
  await host.commands.lark(['im', 'reactions', 'create', '--params', JSON.stringify({ message_id: messageId }),
    '--data', JSON.stringify({ reaction_type: { emoji_type: emoji } })])
}
/**
 * Deletes the bot's own marks of these emoji from a message, so a message wears one mark at a time. A person's reaction with
 * the same emoji stays: only a mark this bot added can be deleted through its own identity.
 */
async function clearMarks(host: Pick<SourceContext, 'commands'>, messageId: string, emojis: readonly string[]): Promise<void> {
  for (const emoji of emojis) {
    let token: string | undefined
    for (let page = 0; page < 5; page++) {
      const params = { message_id: messageId, reaction_type: emoji, page_size: 50, ...token ? { page_token: token } : {} }
      const result = ReactionPage.parse(await host.commands.lark(['im', 'reactions', 'list', '--params', JSON.stringify(params)]))
      const mine = result.items.filter(item => item.reaction_type.emoji_type === emoji && item.operator.operator_type === 'app')
      for (const item of mine) {
        await host.commands.lark(['im', 'reactions', 'delete', '--params', JSON.stringify({ message_id: messageId, reaction_id: item.reaction_id })])
      }
      if (mine.length || !result.has_more || !result.page_token) break
      token = result.page_token
    }
  }
}
/**
 * Marks the message a ticket took up, or leaves the mark its end or a resuming follow-up implies: the finished emoji replaces
 * the working one, and work that resumes takes the finished one back off. A recalled message takes no mark, which the receipt
 * records as `gone`.
 */
export async function reactFeishu(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const messageId = message.channel.address.messageId
  if (!messageId) throw new Error('Missing Feishu mark target')
  try {
    if (message.reaction === 'received') await addMark(host, messageId, TAKEN_UP)
    else if (message.reaction === 'finished') {
      await clearMarks(host, messageId, [TAKEN_UP])
      await addMark(host, messageId, FINISHED)
    } else if (message.reaction === 'reopened') {
      await clearMarks(host, messageId, [FINISHED])
      await addMark(host, messageId, TAKEN_UP)
    } else await clearMarks(host, messageId, [TAKEN_UP, FINISHED])
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
  return 'sent'
}
/** Fallback chat link on the bot's brand; the message's own deep link on its Trigger is preferred when available. */
export const feishuLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => ({
  url: feishuChatLink(links.feishu?.brand ?? 'feishu', address.chatId ?? ''), label: { zh: '飞书消息', en: 'Feishu message' },
  ...address.messageId ? { triggerId: feishuTriggerId(address.messageId) } : {},
})
