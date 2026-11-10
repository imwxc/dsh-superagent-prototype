/** Kim source kind: polls the operator's @-me feed through kim-cli and replies through a group webhook bot. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, threadKey, type ChannelRef, type OutboundMessage, type Trigger } from '../core/index.ts'
import { checkedImText } from '../infra/text.ts'
import { record } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { pause } from './poll.ts'
import type { ChannelLink, SourceKind } from './kind.ts'

export const SOURCE = 'kim'
/** Read cursor: the end of the last poll window (epoch ms); the first run starts at the process start and replays nothing. */
const cursor = record<number>('kim-cursor')
/** A poll window steps back 5 s so late-written feed items are not missed; deterministic trigger IDs deduplicate the overlap. */
const OVERLAP_MS = 5_000
/** A Source that was off for a weekend must not replay it, so a window never reaches further back than one hour. */
const MAX_WINDOW_MS = 3_600_000
/** Pagination ends on the server's `hasMore=false`; a feed that still has pages after this guard fails instead of looping. */
const MAX_PAGES = 100

const KimConfigSchema = z.object({
  cli: z.string().min(1).default('kcli'),
  appKey: z.string().default(''),
  secretKey: z.string().default(''),
  gatewayUrl: z.string().url().default('https://is-gateway.corp.kuaishou.com'),
  chats: z.array(z.object({ sessionId: z.string().regex(/^\d+$/), name: z.string().trim().max(60).optional() }).strict())
    .refine(chats => new Set(chats.map(chat => chat.sessionId)).size === chats.length, 'Duplicate session IDs').default([]),
  pollSeconds: z.number().int().min(10).max(3600).default(30),
}).strict()
export type KimConfig = z.infer<typeof KimConfigSchema>
export { KimConfigSchema }

/** One entry of `kcli kim-cli im +message-list-at-me`; the shape was verified against its live output. */
const AtMeSchema = z.looseObject({
  messageKey: z.string().min(1), createTime: z.number(), senderType: z.string(),
  message: z.looseObject({
    content: z.string().default(''),
    sender: z.looseObject({ username: z.string().default(''), name: z.string().optional() }),
    session: z.looseObject({ groupId: z.string().default('') }),
  }),
})
const PageSchema = z.looseObject({ messageList: z.array(z.unknown()).default([]), hasMore: z.boolean().default(false), cursor: z.number().optional() })

export const kimTriggerId = (messageKey: string): string => key('kim', messageKey)
/** The reply channel of one group chat; the webhook bot posts there by session id. */
export const kimChannel = (sessionId: string): ChannelRef =>
  ({ source: SOURCE, thread: `kim:${sessionId}`, address: { session: sessionId } })
/** Translates one @-me feed entry; group messages with a sender username only, because the Policy names people by username. */
export function kimTrigger(item: unknown): Trigger | undefined {
  const entry = AtMeSchema.parse(item)
  const sessionId = entry.message.session.groupId
  const username = entry.message.sender.username
  if (!sessionId || !username) return undefined
  return { id: kimTriggerId(entry.messageKey), source: SOURCE, threads: [{ source: SOURCE, id: sessionId }],
    actor: { source: SOURCE, id: username }, human: entry.senderType === 'user', addressed: 'mention',
    at: new Date(entry.createTime).toISOString(), text: entry.message.content, channel: kimChannel(sessionId),
    meta: { sessionId, messageKey: entry.messageKey, ...(entry.message.sender.name ? { senderName: entry.message.sender.name } : {}) } }
}

/** kim-cli reads `--start` and `--end` as local `YYYY-MM-DDTHH:mm`. */
function localMinute(ms: number): string {
  const time = new Date(ms)
  const pair = (value: number): string => String(value).padStart(2, '0')
  return `${time.getFullYear()}-${pair(time.getMonth() + 1)}-${pair(time.getDate())}T${pair(time.getHours())}:${pair(time.getMinutes())}`
}

/**
 * OpenAPI credentials for `sendKim`. `SourceChannel.send` receives only commands, so the watch loop refreshes them every
 * cycle; the secret never enters a Trigger's address or meta, which persist and reach the panel.
 */
let sendConfig: { appKey: string; secretKey: string; gatewayUrl: string } | undefined
/** The single write path for `sendConfig`; tests use it to arm the channel. */
export function setKimSendConfig(value: { appKey: string; secretKey: string; gatewayUrl: string } | undefined): void { sendConfig = value }
/** Cached access token; the gateway returns `expireTime` in seconds (12 h in practice). */
let cachedToken: { token: string; expireAt: number } | undefined
/** Permanent message-send rejections: the bot is not in the chat or was blacklisted; throttle and network failures stay retryable. */
const gone = (status: number, body: string): boolean => status !== 200
  || /101220046|10122014|不在群|黑名单/.test(body)
/** Fetches an access token, reusing the cached one until shortly before it expires. */
export async function kimAccessToken(config: { appKey: string; secretKey: string; gatewayUrl: string }): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expireAt - 60_000) return cachedToken.token
  const query = new URLSearchParams({ appKey: config.appKey, secretKey: config.secretKey })
  const response = await fetch(`${config.gatewayUrl}/token/get?${query}`, { signal: AbortSignal.timeout(30_000) })
    .catch((error: unknown) => { throw new Error(`Kim token request failed: ${String(error)}`) })
  const body = await response.text().catch(() => '')
  const parsed = JSON.parse(body || '{}') as { code?: number; message?: string; result?: { accessToken?: string; expireTime?: number } }
  if (!response.ok || parsed.code !== 0 || !parsed.result?.accessToken) {
    throw new Error(`Kim token refused (${parsed.code ?? response.status}): ${parsed.message ?? body.slice(0, 200)}`)
  }
  cachedToken = { token: parsed.result.accessToken, expireAt: Date.now() + (parsed.result.expireTime ?? 3600) * 1000 }
  return cachedToken.token
}
/** Clears the cached token; tests use it between scenarios. */
export function resetKimToken(): void { cachedToken = undefined }
/**
 * Posts one reply as the message-number bot. The gateway's `uniqId` deduplicates for one hour, so a retried send after a
 * timeout does not duplicate the message; a duplicate update is still preferred over a lost one.
 */
export async function sendKim(_host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const session = message.channel.address.session
  if (!session) throw new Error('Missing Kim reply target')
  if (!sendConfig?.appKey || !sendConfig.secretKey) throw new Error('The Kim Source is on without appKey or secretKey')
  const token = await kimAccessToken(sendConfig)
  const body = JSON.stringify({ groupId: session, msgType: 'markdown', markdown: { content: checkedImText(message.text) }, uniqId: message.id })
  const response = await fetch(`${sendConfig.gatewayUrl}/openapi/v2/message/send`,
    { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body, signal: AbortSignal.timeout(30_000) })
    .catch((error: unknown) => { throw new Error(`Kim message request failed: ${String(error)}`) })
  const text = await response.text().catch(() => '')
  const parsed = JSON.parse(text || '{}') as { status?: number; code?: number; message?: string }
  if (parsed.status === 0 && parsed.code === 0) return 'sent'
  if (gone(response.status, text)) return 'gone'
  throw new Error(`Kim message refused (${parsed.code ?? response.status}): ${(parsed.message ?? text).slice(0, 300)}`)
}

export const kimKind: SourceKind<KimConfig> = {
  kind: SOURCE,
  title: { zh: 'Kim', en: 'Kim' },
  description: {
    zh: '轮询 kim-cli「@ 我的消息」，接收下列群里的 @ 消息，经群里自定义机器人的 webhook 回复。',
    en: 'Polls the kim-cli @-me feed for messages in these chats and replies through a group webhook bot.',
  },
  schema: KimConfigSchema,
  fields: [
    { key: 'cli', type: 'text', label: { zh: 'kcli 命令', en: 'kcli command' },
      hint: { zh: '命令名或绝对路径；它以操作者的 Kim 身份读取 @ 我的消息。', en: 'A command name or absolute path; it reads the @-me feed as the operator.' } },
    { key: 'appKey', type: 'text', label: { zh: '消息号 appKey', en: 'Message-number appKey' },
      hint: { zh: 'OpenAPI 应用的正式环境 appKey；在 openapi.corp.kuaishou.com 我的应用里查看。', en: 'The production appKey of the OpenAPI app; see My Applications on openapi.corp.kuaishou.com.' } },
    { key: 'secretKey', type: 'text', label: { zh: '消息号 secretKey', en: 'Message-number secretKey' },
      hint: { zh: '配套的正式环境 secretKey；只保存在本机配置，不进入任何工单记录。', en: 'The matching production secretKey; it stays in local configuration and never enters a ticket record.' } },
    { key: 'gatewayUrl', type: 'text', advanced: true, label: { zh: 'OpenAPI 网关地址', en: 'OpenAPI gateway URL' } },
    { key: 'chats', type: 'rows', label: { zh: '接收的群', en: 'Chats' },
      hint: { zh: '只接收这些群里的 @ 消息；sessionId 是消息里 session.groupId 的一串数字。', en: 'Receives @ messages from these chats only; a sessionId is the numeric session.groupId of a message.' },
      columns: [
        { key: 'sessionId', type: 'text', label: { zh: '群', en: 'Chat' }, pattern: '\\d+' },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 10, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / s' } },
  ],
  health: ['kim'],
  scope({ meta }, config) {
    const chat = config.chats.find(item => item.sessionId === meta.sessionId)
    return chat ? { listened: true, observed: false, row: chat.sessionId } : { listened: false, reason: 'chat_not_listed' }
  },
  // A reply goes only to a chat the Source still receives; the webhook bot sends to that chat alone through groupIds.
  channel: {
    allowed: (address, config) => config.chats.some(item => item.sessionId === address.session),
    send: sendKim,
    link: (address): ChannelLink =>
      ({ url: `kim://thread?id=${encodeURIComponent(address.session ?? '')}&type=4`, label: { zh: 'Kim 消息', en: 'Kim message' } }),
  },
  find: query => ({ threads: [], terms: [...new Set(query.match(/OMSG_[A-Za-z0-9_-]+/g) ?? [])] }),
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict()).default([]),
    }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Kim 用户', en: 'Kim users who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '用户名', en: 'Username' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: {
      zh: '名单里的人在接收的群里 @ 监听账号。监听账号是 kim-cli 登录的操作者 Kim 身份，回复则来自群里的 webhook 机器人。',
      en: 'Someone on the list mentions the watched account in a received chat. The watched account is the operator\'s Kim identity (the kim-cli login); replies come from the chat\'s webhook bot.',
    },
    rows(stored) {
      const config = KimConfigSchema.parse(stored)
      const note = { zh: '仅 @', en: '@ only' }
      return config.chats.map(chat => ({ id: chat.sessionId, label: chat.name || chat.sessionId, note,
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }))
    },
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_KIM_CHAT', description: {
      zh: '接下工单的 Kim 群 sessionId；工单不是从 Kim 来的时候为空',
      en: 'The sessionId of the Kim chat that started the ticket; empty when the ticket did not start on Kim' } }],
    values: ({ trigger }) => ({ DSH_SUPERAGENT_KIM_CHAT: trigger?.source === SOURCE ? String(trigger.meta.sessionId ?? '') : '' }),
  },
}

/** Reads the @-me feed created inside the window after the cursor, takes in each listed chat's messages, then moves the cursor. */
export async function pollAtMe(ctx: SourceContext, config: KimConfig, signal: AbortSignal): Promise<{ read: number; unreadable: number }> {
  const end = Date.now()
  const start = Math.max((ctx.state.get(cursor) ?? end) - OVERLAP_MS, end - MAX_WINDOW_MS)
  const chats = new Set(config.chats.map(chat => chat.sessionId))
  const seen = new Set<string>()
  let read = 0
  let unreadable = 0
  let pageCursor: number | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (signal.aborted) throw new Error('The Kim Source stopped during the read')
    const args = ['kim-cli', 'im', '+message-list-at-me', '--start', localMinute(start), '--end', localMinute(end), '--limit', '50',
      ...(pageCursor === undefined ? [] : ['--cursor', String(pageCursor)])]
    const feed = PageSchema.parse(JSON.parse(await ctx.commands.withSignal(signal).run(config.cli, args)))
    for (const item of feed.messageList) {
      const parsed = AtMeSchema.safeParse(item)
      if (!parsed.success) { unreadable += 1; continue }
      if (seen.has(parsed.data.messageKey)) continue
      seen.add(parsed.data.messageKey)
      // The Source drops chats it does not listen to before they enter the domain; the panel explains the rest through scope.
      if (!chats.has(parsed.data.message.session.groupId)) continue
      const trigger = kimTrigger(item)
      if (!trigger) continue
      await ctx.receive(trigger)
      for (const ref of trigger.threads)
        ctx.threads.describe(threadKey(ref), { facts: { chat: { label: { zh: '群', en: 'Chat' }, value: String(trigger.meta.sessionId) } } })
      read += 1
    }
    if (!feed.hasMore || feed.cursor === undefined) { pageCursor = undefined; break }
    pageCursor = feed.cursor
  }
  if (pageCursor !== undefined) throw new Error(`The Kim @-me feed still had pages after ${MAX_PAGES}`)
  ctx.state.set(cursor, end)
  return { read, unreadable }
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<KimConfig>(SOURCE)
    if (!config) { ctx.report(SOURCE, health('paused', 'sourceOff')); setKimSendConfig(undefined) }
    else {
      setKimSendConfig({ appKey: config.appKey, secretKey: config.secretKey, gatewayUrl: config.gatewayUrl })
      try {
        const { read, unreadable } = await pollAtMe(ctx, config, signal)
        failures = 0
        ctx.report(SOURCE, { state: 'ready', detail: `${read} messages, ${unreadable} unreadable`, at: new Date().toISOString() })
      } catch (error) {
        failures += 1
        // One failed poll retries on the next round; three in a row need a person.
        if (!signal.aborted && failures >= 3) ctx.report(SOURCE, health('error', 'pollFailures', { count: String(failures), error: String(error) }))
      }
    }
    await pause((config?.pollSeconds ?? 30) * 1000, signal)
  }
  setKimSendConfig(undefined)
}

export const name = 'dsh-superagent-kim'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(kimKind), 'kim: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, kimKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
