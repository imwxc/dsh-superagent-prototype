/** Built-in Manual source: the operator injects a message through the management API, and the agent's replies settle on the panel. */
import { z } from 'zod'
import type { ChannelRef, OutboundMessage, Trigger } from '../core/index.ts'
import { checkedImText } from '../infra/text.ts'
import type { ChannelLink, SourceKind } from './kind.ts'

export const SOURCE = 'manual'
export const manualChannel = (session: string): ChannelRef =>
  ({ source: SOURCE, thread: `manual:${session}`, address: { session } })
/** Wraps one management-API message; the operator is the actor, so the Policy's `manual` list admits it like any other sender. */
export function manualTrigger(text: string, session = 'direct', id: string = crypto.randomUUID()): Trigger {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('The manual message is empty')
  return { id: key(id), source: SOURCE, threads: [{ source: SOURCE, id: session }],
    actor: { source: SOURCE, id: 'operator' }, human: true, addressed: 'direct', at: new Date().toISOString(),
    text: trimmed, channel: manualChannel(session), meta: { sessionId: session } }
}
/** Prefixes caller-supplied IDs with the source namespace so a client-replayed ID cannot collide with a real source trigger. */
function key(id: string): string { return `manual:${id}` }

export const manualKind: SourceKind<Record<string, never>> = {
  kind: SOURCE,
  title: { zh: '本地对话', en: 'Manual' },
  description: {
    zh: '从管理面板/HTTP API 直接给 agent 发消息；回复留在面板线程里，不发到任何 IM。',
    en: 'Send messages to the agent from the management panel/API; replies stay on the panel thread instead of any IM.',
  },
  schema: z.object({}).strict(),
  fields: [],
  health: [],
  scope: () => ({ listened: true, observed: false, row: 'direct' }),
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict()).default([{ id: 'operator' }]),
    }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的操作者', en: 'Operators who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '用户名', en: 'Username' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: {
      zh: '本机操作者通过管理 API 直接对 agent 说话；名单里的人以 operator 身份发起的消息视为明确指派。',
      en: 'The local operator talks to the agent through the management API; a message from a listed operator is an explicit request.',
    },
  },
  channel: {
    allowed: () => true,
    // The panel thread already shows the agent's work; the IM receipt settles immediately instead of retrying forever.
    send: async (_host, message) => { checkedImText(message.text); return 'sent' },
    link: (address): ChannelLink => ({ url: '', label: { zh: '本地对话', en: 'Manual chat' } }),
  },
}
