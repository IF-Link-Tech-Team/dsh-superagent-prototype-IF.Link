import { describe, expect, it } from 'vitest'
import { clawchatTrigger, clawchatTriggerId, chunkText, deriveWsDeviceId, jwtClaims, newMessageId, newRestDeviceId, renderFragments,
  type ClawChatInbound } from '../src/sources/clawchat.ts'

const inbound = (fields: Partial<ClawChatInbound> = {}): ClawChatInbound => ({ messageId: 'msg-1', chatId: 'cnv_1', chatType: 'group',
  senderId: 'usr_alice', senderName: 'Alice', text: 'hi', addressed: false, emittedAt: Date.parse('2026-11-13T02:00:00Z'), ...fields })

describe('clawchat source', () => {
  it('renders mentions and media the way the host should read them', () => {
    expect(renderFragments([{ kind: 'text', text: '你好 ' }, { kind: 'mention', display: '小王' }, { kind: 'image', name: 'p.png' }]))
      .toBe('你好 @小王!**p.png**')
    // A mention without a display name falls back to its id, and an attachment fragment shows its name.
    expect(renderFragments([{ kind: 'mention', user_id: 'usr_x' }, { kind: 'file', name: 'a.pdf' }])).toBe('@usr_x**a.pdf**')
    expect(renderFragments([{ kind: 'text', text: '   ' }])).toBe('')
  })
  it('splits long text on the protocol boundary and closes a fenced block across the split', () => {
    expect(chunkText('a'.repeat(9000)).map(part => part.length)).toEqual([4000, 4000, 1000])
    const fenced = '```js\n' + 'x'.repeat(8000) + '\n```'
    const parts = chunkText(fenced)
    expect(parts.length).toBeGreaterThan(1)
    // Every chunk must be valid markdown on its own: the fence opened in a later chunk is closed in that same chunk.
    for (const part of parts) expect((part.match(/^```/gm) ?? []).length % 2).toBe(0)
  })
  it('mints ids the server accepts: a msg- prefix and a 26-character ULID', () => {
    const id = newMessageId()
    expect(id).toMatch(/^msg-[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(newMessageId()).not.toBe(id)
    expect(newRestDeviceId()).toMatch(/^dsh-superagent-[a-f0-9]{24}$/)
  })
  it('derives one stable WebSocket device id per identity, so a restart is not a new device', () => {
    const first = deriveWsDeviceId({ userId: 'usr_a', ownerId: 'usr_b' })
    expect(first).toBe(deriveWsDeviceId({ userId: 'usr_a', ownerId: 'usr_b' }))
    expect(first).not.toBe(deriveWsDeviceId({ userId: 'usr_c', ownerId: 'usr_b' }))
  })
  it('reads the JWT claims the self-echo check depends on, and never verifies it', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'usr_agent', oid: 'usr_owner', aid: 'agt_1', exp: 1800000000 })).toString('base64url')
    expect(jwtClaims(`header.${payload}.signature`)).toMatchObject({ sub: 'usr_agent', oid: 'usr_owner', aid: 'agt_1' })
    expect(jwtClaims('not-a-jwt')).toEqual({})
  })
  it('addresses the agent in a direct chat and on a mention, and leaves other group messages unaddressed', () => {
    const direct = clawchatTrigger(inbound({ chatType: 'direct' }))
    expect(direct.addressed).toBe('direct')
    expect(direct.channel?.address).toMatchObject({ chatId: 'cnv_1', messageId: 'msg-1', direct: 'true' })
    expect(clawchatTrigger(inbound({ addressed: true })).addressed).toBe('mention')
    expect(clawchatTrigger(inbound()).addressed).toBeUndefined()
    // The Thread is the conversation, so every message in one chat lands on one Thread.
    expect(clawchatTrigger(inbound()).threads).toEqual([{ source: 'clawchat', id: 'clawchat:cnv_1' }])
    expect(clawchatTrigger(inbound({ replyTo: 'msg-0' })).meta).toMatchObject({ parentId: 'msg-0' })
  })
  it('keys a Trigger by its message id, so a reconnect replay cannot add the same message twice', () => {
    expect(clawchatTriggerId('msg-1')).toBe(clawchatTriggerId('msg-1'))
    expect(clawchatTriggerId('msg-1')).not.toBe(clawchatTriggerId('msg-2'))
    expect(clawchatTrigger(inbound()).id).toBe(clawchatTriggerId('msg-1'))
  })
})
