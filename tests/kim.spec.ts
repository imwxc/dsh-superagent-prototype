import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { record } from '../src/kv.ts'
import { HealthBoard } from '../src/infra/health.ts'
import {
  KimConfigSchema, kimCallbackTrigger, kimKind, kimTrigger, kimTriggerId, pollAtMe, relayPull, sendKim, setKimSendConfig,
  resetKimToken, startCallbackServer, SOURCE,
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
    expect(config).toMatchObject({ cli: 'kcli', gatewayUrl: 'https://is-gateway.corp.kuaishou.com', appKey: '', secretKey: '', chats: [], pollSeconds: 30 })
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
  const arm = () => setKimSendConfig({ appKey: 'ak-1', secretKey: 'sk-1', gatewayUrl: 'https://gateway.test' })
  afterEach(() => { vi.unstubAllGlobals(); setKimSendConfig(undefined); resetKimToken() })
  it('fetches a token, posts markdown by group with uniqId, and reuses the cached token', async () => {
    arm()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"code":0,"result":{"accessToken":"t-1","expireTime":3600}}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"status":0,"code":0,"message":"success","data":{"messageKey":["OMSG_x"]}}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(sendKim({} as Parameters<typeof sendKim>[0], message)).resolves.toBe('sent')
    const [tokenUrl] = fetchMock.mock.calls[0] as unknown as [string]
    expect(tokenUrl).toBe('https://gateway.test/token/get?appKey=ak-1&secretKey=sk-1')
    const [sendUrl, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(sendUrl).toBe('https://gateway.test/openapi/v2/message/send')
    expect(init.headers).toMatchObject({ authorization: 'Bearer t-1' })
    expect(JSON.parse(String(init.body))).toEqual({ groupId: '7377459320328271', msgType: 'markdown', markdown: { content: 'done' }, uniqId: 'm1' })
    // The second send reuses the cached token and goes straight to message/send.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{"status":0,"code":0}', { status: 200 })))
    await expect(sendKim({} as Parameters<typeof sendKim>[0], message)).resolves.toBe('sent')
  })
  it('refuses an error token answer and reports gateway refusals as retryable failures', async () => {
    arm(); resetKimToken()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{"code":40109,"message":"secret.key.error"}', { status: 200 })))
    await expect(sendKim({} as Parameters<typeof sendKim>[0], message)).rejects.toThrow(/40109/)
    arm(); resetKimToken()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('{"code":0,"result":{"accessToken":"t-2","expireTime":3600}}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"status":5,"code":10122013,"message":"限流"}', { status: 200 })))
    await expect(sendKim({} as Parameters<typeof sendKim>[0], message)).rejects.toThrow(/10122013/)
  })
  it('reports a gone chat, and refuses without credentials', async () => {
    arm(); resetKimToken()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('{"code":0,"result":{"accessToken":"t-3","expireTime":3600}}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"status":5,"code":101220046,"message":"机器人不在群"}', { status: 200 })))
    await expect(sendKim({} as Parameters<typeof sendKim>[0], message)).resolves.toBe('gone')
    setKimSendConfig(undefined)
    await expect(sendKim({} as Parameters<typeof sendKim>[0], message)).rejects.toThrow(/appKey or secretKey/)
  })
})

/** One callback event in the shape the OpenAPI gateway posts (verified against cyber-tower-node's receiver DTO). */
const callbackEvent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  uuid: 'u-1', tagList: [], token: 'tok-1', timestamp: 1794228285107, appId: 'app-1', eventType: 'message',
  info: {
    messageKey: 'OMSG_callone', sender: { userId: '233300731420243', username: 'jiangduo03', name: '姜铎', userType: 'user' },
    sessionType: 'group', session: { from: '233300731420243', to: '', groupId: '7377459320328271' },
    mentionAll: false, mentionList: [{ username: 'dsh_bot' }], messageType: 'text',
    content: '@dsh_bot 帮忙看下这个服务', contentWithoutAtBot: '帮忙看下这个服务',
  },
  callBackUrl: 'http://callback', botKwaiUserId: 42, urlSchemeParam: null,
  ...over,
})

describe('kimCallbackTrigger', () => {
  it('translates a group callback into the same trigger shape the poll produces', () => {
    expect(kimCallbackTrigger(callbackEvent())).toMatchObject({
      id: kimTriggerId('OMSG_callone'), source: 'kim',
      threads: [{ source: 'kim', id: '7377459320328271' }],
      actor: { source: 'kim', id: 'jiangduo03' }, human: true, addressed: 'mention',
      at: new Date(1794228285107).toISOString(),
      text: '帮忙看下这个服务',
      channel: { source: 'kim', thread: 'kim:7377459320328271', address: { session: '7377459320328271' } },
      meta: { sessionId: '7377459320328271', messageKey: 'OMSG_callone', senderName: '姜铎' },
    })
  })
  it('skips direct messages and senders without a username, and rejects garbage payloads', () => {
    expect(kimCallbackTrigger(callbackEvent({ info: { ...callbackEvent().info as object, sessionType: 'p2p' } }))).toBeUndefined()
    expect(kimCallbackTrigger(callbackEvent({ info: { ...callbackEvent().info as object, session: { from: '1', to: '2', groupId: null } } }))).toBeUndefined()
    expect(kimCallbackTrigger(callbackEvent({ info: { ...callbackEvent().info as object, sender: { userId: '1', username: '', name: '', userType: null } } }))).toBeUndefined()
    expect(() => kimCallbackTrigger({ token: 't', timestamp: 1, info: 'not an object' })).toThrow()
  })
})

describe('startCallbackServer', () => {
  /** A minimal SourceContext recording receives; the callback server only needs `receive` and `threads`. */
  function recordingContext() {
    const received: Trigger[] = []
    const value = {
      receive: async (trigger: Trigger) => { received.push(trigger) },
      threads: { describe: () => {} },
    } as unknown as SourceContext
    return { value, received }
  }
  const config = KimConfigSchema.parse({ chats: [{ sessionId: '7377459320328271' }], callbackPort: 0, callbackToken: 'tok-1' })
  const post = (port: number, path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  it('verifies the token, ingests group events, and skips direct messages', async () => {
    const controller = new AbortController()
    const { value, received } = recordingContext()
    const server = await startCallbackServer(value, config, controller.signal)
    try {
      const port = (server.address() as { port: number }).port
      expect((await fetch(`http://127.0.0.1:${port}/kim/callback`)).status).toBe(200)
      expect((await post(port, '/kim/other', callbackEvent())).status).toBe(404)
      expect((await post(port, '/kim/callback', { token: 'wrong', timestamp: 1, info: {} })).status).toBe(400)
      expect((await post(port, '/kim/callback', callbackEvent({ token: 'wrong' }))).status).toBe(403)
      expect((await post(port, '/kim/callback', callbackEvent({ info: { ...callbackEvent().info as object, sessionType: 'p2p' } }))).status).toBe(200)
      const ok = await post(port, '/kim/callback', callbackEvent())
      expect(ok.status).toBe(200)
      await expect(ok.json()).resolves.toEqual({ code: 1, message: 'SUCCESS' })
      expect(received.map(item => item.id)).toEqual([kimTriggerId('OMSG_callone')])
      expect(received[0]).toMatchObject({ actor: { id: 'jiangduo03' }, text: '帮忙看下这个服务' })
    } finally { controller.abort(); await closeCallbackServerForTest(server) }
  })
  it('refuses to serve without a configured token', async () => {
    const controller = new AbortController()
    const { value, received } = recordingContext()
    const server = await startCallbackServer(value, KimConfigSchema.parse({ callbackPort: 0 }), controller.signal)
    try {
      const port = (server.address() as { port: number }).port
      expect((await post(port, '/kim/callback', callbackEvent())).status).toBe(403)
      expect(received).toEqual([])
    } finally { controller.abort(); await closeCallbackServerForTest(server) }
  })
})

/** Closes a test server after its abort listener ran, so the port frees before the next test binds. */
async function closeCallbackServerForTest(server: import('node:http').Server): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 20))
  await new Promise<void>(resolve => server.close(() => resolve()))
}

describe('relayPull', () => {
  /** The tower response envelope nests the page under `data.data`; one group event plus one p2p event. */
  const envelope = (events: { id: string; payload: unknown }[]) => new Response(JSON.stringify({
    code: 0, success: true, traceId: 't', status: 0, message: '',
    data: { code: 1, message: 'SUCCESS', data: events, queueSize: events.length },
  }), { status: 200 })
  const config = KimConfigSchema.parse({ chats: [{ sessionId: '7377459320328271' }], relayUrl: 'https://tower.test', relayToken: 'tok-1' })

  function recordingContext() {
    const received: Trigger[] = []
    const value = {
      receive: async (trigger: Trigger) => { received.push(trigger) },
      threads: { describe: () => {} },
    } as unknown as SourceContext
    return { value, received }
  }

  afterEach(() => { vi.unstubAllGlobals() })

  it('ingests relayed events and acks only the translated ones', async () => {
    const { value, received } = recordingContext()
    const group = callbackEvent()
    const p2p = callbackEvent({ info: { ...group.info as object, sessionType: 'p2p' } })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(envelope([{ id: 'e-1', payload: group }, { id: 'e-2', payload: p2p }]))
      .mockResolvedValueOnce(envelope([]))
    vi.stubGlobal('fetch', fetchMock)
    await expect(relayPull(value, config, new AbortController().signal)).resolves.toEqual({ read: 1 })
    expect(received.map(item => item.id)).toEqual([kimTriggerId('OMSG_callone')])
    const [, ackInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(String(ackInit.body)).toBe(JSON.stringify({ ids: ['e-1'] }))
  })
  it('refuses a relay without a token, and an error page keeps events queued', async () => {
    const { value } = recordingContext()
    const noToken = KimConfigSchema.parse({ relayUrl: 'https://tower.test' })
    await expect(relayPull(value, noToken, new AbortController().signal)).rejects.toThrow(/without relayToken/)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('relay token mismatch', { status: 403 })))
    await expect(relayPull(value, config, new AbortController().signal)).rejects.toThrow(/pull refused/)
  })
})
