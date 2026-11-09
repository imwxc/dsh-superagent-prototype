import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { record } from '../src/kv.ts'
import { HealthBoard } from '../src/infra/health.ts'
import {
  KimConfigSchema, kimKind, kimTrigger, kimTriggerId, pollAtMe, sendKim, setKimSendConfig, SOURCE,
} from '../src/sources/kim.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Key } from '../src/kv.ts'
import type { SourceContext } from '../src/sources/host.ts'

/** One @-me feed entry in the live shape `kcli kim-cli im +message-list-at-me` printed on 2026-11-09. */
const atMe = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  messageKey: 'OMSG_BAAAAG98MhfhXgYAuHGSU9dfBgBT3jiPL9QAAE8QIprCNRoA',
  createTime: 1794228285107,
  senderType: 'user',
  message: {
    content: '@王咸郤 帮忙看下这个服务',
    mentionList: [{ userId: '216694959713256', username: 'wangxianchen' }],
    sender: { name: '姜铎', userId: '233300731420243', username: 'jiangduo03' },
    session: { from: '233300731420243', groupId: '7377459320328271', to: '', type: 4 },
    messageType: 'text',
  },
  ...over,
})

describe('kimTrigger', () => {
  it('translates a group @-me message', () => {
    expect(kimKind.kind).toBe(SOURCE)
    const value = kimTrigger(atMe()) as Trigger
    expect(value).toMatchObject({
      id: kimTriggerId('OMSG_BAAAAG98MhfhXgYAuHGSU9dfBgBT3jiPL9QAAE8QIprCNRoA'),
      source: 'kim',
      threads: [{ source: 'kim', id: '7377459320328271' }],
      actor: { source: 'kim', id: 'jiangduo03' },
      human: true,
      addressed: 'mention',
      at: new Date(1794228285107).toISOString(),
      text: '@王咸郤 帮忙看下这个服务',
      channel: { source: 'kim', thread: 'kim:7377459320328271', address: { session: '7377459320328271' } },
      meta: { sessionId: '7377459320328271', senderName: '姜铎' },
    })
  })
  it('skips a direct message without a group session and a sender without a username', () => {
    expect(kimTrigger(atMe({ message: { ...atMe().message as object, session: { from: '1', groupId: '', to: '2', type: 1 } } }))).toBeUndefined()
    expect(kimTrigger(atMe({ message: { ...atMe().message as object, sender: { name: '', userId: '1', username: '' } } }))).toBeUndefined()
    expect(() => kimTrigger({ messageKey: 'x', createTime: 1, senderType: 'user', message: 'not an object' })).toThrow()
  })
})

describe('kimKind', () => {
  it('defaults its configuration and validates chats', () => {
    const config = KimConfigSchema.parse({})
    expect(config).toMatchObject({ cli: 'kcli', webhookUrl: 'https://kim-robot.kwaitalk.com/api/robot/send', webhookKey: '', chats: [], pollSeconds: 30 })
    expect(KimConfigSchema.safeParse({ chats: [{ sessionId: 'abc' }] }).success).toBe(false)
    expect(KimConfigSchema.safeParse({ chats: [{ sessionId: '1' }, { sessionId: '1' }] }).success).toBe(false)
  })
  it('listens only to listed chats and never observes unaddressed messages', () => {
    const config = KimConfigSchema.parse({ chats: [{ sessionId: '7377459320328271' }] })
    expect(kimKind.scope!({ meta: { sessionId: '7377459320328271' } }, config)).toEqual({ listened: true, observed: false, row: '7377459320328271' })
    expect(kimKind.scope!({ meta: { sessionId: '42' } }, config)).toEqual({ listened: false, reason: 'chat_not_listed' })
  })
  it('allows replies only to chats it still receives', () => {
    const config = KimConfigSchema.parse({ chats: [{ sessionId: '7377459320328271' }] })
    expect(kimKind.channel!.allowed!({ session: '7377459320328271' }, config)).toBe(true)
    expect(kimKind.channel!.allowed!({ session: '42' }, config)).toBe(false)
  })
  it('describes its admission rows from the chats and registers its health entry', () => {
    const config = KimConfigSchema.parse({ chats: [{ sessionId: '7377459320328271', name: '资产服务群' }] })
    expect(kimKind.policy!.rows!(config as Record<string, unknown>)).toEqual([
      { id: '7377459320328271', label: '资产服务群', note: { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }])
    const registry = new SourceRegistry(() => SettingsSchema.parse({}), new HealthBoard())
    const dispose = registry.register(kimKind)
    expect(registry.kind('kim')).toBe(kimKind)
    dispose()
  })
})

/** A minimal SourceContext for `pollAtMe`: canned CLI pages, an in-memory KV, and recorded receives. */
function context(feed: (call: number) => string) {
  const state = new Map<string, unknown>()
  const received: Trigger[] = []
  let call = 0
  const value: SourceContext = {
    commands: { withSignal: () => ({ run: async () => feed(call++) }) },
    state: {
      get: <V>(key: Key<V>) => state.get(key) as V | undefined,
      set: <V>(key: Key<V>, value: V | undefined) => { state.set(key, value) },
      keys: () => [],
    },
    receive: async (trigger: Trigger) => { received.push(trigger) },
    threads: { describe: () => {} },
  } as unknown as SourceContext
  return { value, state, received }
}

describe('pollAtMe', () => {
  const config = KimConfigSchema.parse({ chats: [{ sessionId: '7377459320328271' }] })
  it('takes in listed chats only, deduplicates, pages by the server cursor, and advances the cursor', async () => {
    const first = atMe({ messageKey: 'OMSG_one' })
    const repeat = atMe({ messageKey: 'OMSG_one' })
    const other = atMe({ messageKey: 'OMSG_two', message: { ...(atMe().message as object), session: { groupId: '999', type: 4 } } })
    const second = atMe({ messageKey: 'OMSG_three', createTime: 1794228285999 })
    const broken = { messageKey: 42 }
    const before = Date.now()
    const { value, state, received } = await (async () => {
      const made = context(call =>
        call === 0
          ? JSON.stringify({ messageList: [first, repeat, other, broken], hasMore: true, cursor: 1794214531194 })
          : JSON.stringify({ messageList: [second], hasMore: false }))
      const result = await pollAtMe(made.value, config, new AbortController().signal)
      expect(result).toEqual({ read: 2, unreadable: 1 })
      return made
    })()
    expect(received.map(item => item.id)).toEqual([kimTriggerId('OMSG_one'), kimTriggerId('OMSG_three')])
    const cursor = record<number>('kim-cursor')
    const advanced = state.get(cursor)!
    expect(advanced).toBeGreaterThanOrEqual(before)
    expect(advanced).toBeLessThanOrEqual(Date.now())
  })
  it('replays nothing before its first cursor', async () => {
    const { value, received, state } = context(() => JSON.stringify({ messageList: [atMe()], hasMore: false }))
    const result = await pollAtMe(value, config, new AbortController().signal)
    // The first run still reads the current window (a message @-me from within it is real work, not replay); only older quiet time is skipped.
    expect(result.read).toBe(1)
    expect(received).toHaveLength(1)
    expect(state.get(record<number>('kim-cursor'))).toBeDefined()
  })
  it('fails a feed that still has pages after the guard', async () => {
    const { value } = context(() => JSON.stringify({ messageList: [], hasMore: true, cursor: 1 }))
    await expect(pollAtMe(value, config, new AbortController().signal)).rejects.toThrow(/still had pages/)
  })
})

describe('sendKim', () => {
  const message = { id: 'm1', text: 'done', channel: { source: SOURCE, thread: 'kim:7', address: { session: '7377459320328271' } } } as unknown as Parameters<typeof sendKim>[1]
  afterEach(() => { vi.unstubAllGlobals(); setKimSendConfig(undefined) })
  it('posts markdown to the webhook with the chat as the only group and requires a messageKey', async () => {
    setKimSendConfig({ url: 'https://kim-robot.kwaitalk.com/api/robot/send', key: 'k-1' })
    const fetchMock = vi.fn(async () => new Response('{"messageKey":"OMSG_out"}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(sendKim({} as Parameters<typeof sendKim>[0], message)).resolves.toBe('sent')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://kim-robot.kwaitalk.com/api/robot/send?key=k-1')
    expect(JSON.parse(String(init.body))).toEqual({ msgtype: 'markdown', markdown: { content: 'done' }, groupIds: ['7377459320328271'] })
    const silent = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', silent)
    await expect(sendKim({} as Parameters<typeof sendKim>[0], message)).rejects.toThrow(/accepted no message/)
  })
  it('reports a gone chat, retries other failures, and refuses without a key', async () => {
    setKimSendConfig({ url: 'https://x/', key: 'k-1' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no such group', { status: 404 })))
    await expect(sendKim({} as Parameters<typeof sendKim>[0], message)).resolves.toBe('gone')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('many requests', { status: 429 })))
    await expect(sendKim({} as Parameters<typeof sendKim>[0], message)).rejects.toThrow(/429/)
    setKimSendConfig(undefined)
    await expect(sendKim({} as Parameters<typeof sendKim>[0], message)).rejects.toThrow(/webhook key/)
  })
})
