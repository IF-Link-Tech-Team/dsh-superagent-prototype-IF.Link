/** Feishu marks a message took-up on, and the finished mark its end leaves. */
import { expect, it } from 'vitest'
import type { OutboundMessage, ReactionKind } from '../src/core/index.ts'
import { CliError } from '../src/infra/commands.ts'
import { reactFeishu } from '../src/sources/feishu-channel.ts'

const channel = { source: 'feishu', thread: 'feishu:oc_x', address: { chatId: 'oc_x', messageId: 'om_x' } }
const mark = (reaction: ReactionKind): OutboundMessage => ({ id: `mark-${reaction}`, channel, text: '', kind: 'reaction', reaction })
const bot = { reaction_id: 'r1', operator: { operator_type: 'app' }, reaction_type: { emoji_type: 'OnIt' } }
const person = { reaction_id: 'r2', operator: { operator_type: 'user' }, reaction_type: { emoji_type: 'OnIt' } }
const done = { reaction_id: 'r3', operator: { operator_type: 'app' }, reaction_type: { emoji_type: 'DONE' } }
const onePage = (items: unknown[]) => ({ items, has_more: false })
/** A Source context whose `lark` answers the given results in order and records every command. */
function host(answers: unknown[]) {
  const calls: string[][] = []
  const commands = { lark: async (args: string[]) => {
    calls.push(args)
    const next = answers.shift()
    if (next instanceof Error) throw next
    return next
  } }
  return { calls, host: { commands } as never }
}

it('takes a message up with the taken-up emoji, as the bot', async () => {
  const { calls, host: h } = host([{ reaction_id: 'r1' }])
  expect(await reactFeishu(h, mark('received'))).toBe('sent')
  expect(calls).toEqual([['im', 'reactions', 'create', '--params', '{"message_id":"om_x"}', '--data', '{"reaction_type":{"emoji_type":"OnIt"}}']])
})

it('drops the taken-up emoji before it leaves the finished one, so the message wears a single mark', async () => {
  const { calls, host: h } = host([onePage([bot]), { reaction_id: 'r3' }, { reaction_id: 'r3' }])
  expect(await reactFeishu(h, mark('finished'))).toBe('sent')
  expect(calls.map(args => args.slice(0, 3).join(' '))).toEqual(['im reactions list', 'im reactions delete', 'im reactions create'])
  expect(JSON.parse(calls[1]![4]!)).toEqual({ message_id: 'om_x', reaction_id: 'r1' })
  expect(JSON.parse(calls[2]![6]!)).toEqual({ reaction_type: { emoji_type: 'DONE' } })
})

it('takes the mark away when the ticket ended otherwise, keeping a person\'s equal reaction', async () => {
  const { calls, host: h } = host([onePage([person]), onePage([])])
  expect(await reactFeishu(h, mark('withdrawn'))).toBe('sent')
  // The person's OnIt stays: only the bot's own mark is deleted, and it looked for both marks it may have left.
  expect(calls.map(args => args.slice(0, 3).join(' '))).toEqual(['im reactions list', 'im reactions list'])
  expect(JSON.parse(calls[1]![4]!)).toMatchObject({ reaction_type: 'DONE' })
})

it('takes the finished mark off and works again when a follow-up resumes the ticket', async () => {
  const { calls, host: h } = host([onePage([done]), { reaction_id: 'r1' }, { reaction_id: 'r1' }])
  expect(await reactFeishu(h, mark('reopened'))).toBe('sent')
  expect(calls.map(args => args.slice(0, 3).join(' '))).toEqual(['im reactions list', 'im reactions delete', 'im reactions create'])
  expect(JSON.parse(calls[1]![4]!)).toEqual({ message_id: 'om_x', reaction_id: 'r3' })
  expect(JSON.parse(calls[2]![6]!)).toEqual({ reaction_type: { emoji_type: 'OnIt' } })
})

it('answers gone for a recalled message, whose mark can no longer be added', async () => {
  const { host: h } = host([new CliError('message withdrawn', 230011)])
  expect(await reactFeishu(h, mark('received'))).toBe('gone')
})

it('throws any other failure, so a Channel that may answer later is tried again', async () => {
  const { host: h } = host([new Error('boom')])
  await expect(reactFeishu(h, mark('received'))).rejects.toThrow('boom')
})
