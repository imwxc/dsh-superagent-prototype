import { describe, expect, it } from 'vitest'
import { manualChannel, manualKind, manualTrigger, SOURCE } from '../src/sources/manual.ts'
import type { Trigger } from '../src/core/index.ts'

describe('manualKind', () => {
  it('parses an empty config and always listens on its single row', () => {
    expect(manualKind.kind).toBe(SOURCE)
    expect(manualKind.schema.parse({})).toEqual({})
    expect(manualKind.scope!({ meta: { sessionId: 'anything' } }, {})).toEqual({ listened: true, observed: false, row: 'direct' })
    expect(manualKind.health).toEqual([])
  })
  it('defaults its policy roster to the local operator', () => {
    const policy = manualKind.policy!.schema.parse({})
    expect(policy.allowed).toEqual([{ id: 'operator' }])
  })
})

describe('manualTrigger', () => {
  it('wraps a message with deterministic ids per call and a direct address', () => {
    const trigger = manualTrigger('  帮我看下服务  ', 'chat-1', 'test-1') as Trigger
    expect(trigger).toMatchObject({
      id: 'manual:test-1', source: 'manual', threads: [{ source: 'manual', id: 'chat-1' }],
      actor: { source: 'manual', id: 'operator' }, human: true, addressed: 'direct',
      text: '帮我看下服务', channel: { source: 'manual', thread: 'manual:chat-1', address: { session: 'chat-1' } },
      meta: { sessionId: 'chat-1' },
    })
    expect(() => manualTrigger('   ')).toThrow(/empty/)
  })
  it('settles channel sends immediately so the outbox never retries them', async () => {
    const send = manualKind.channel!.send
    const message = { id: 'm1', text: 'done', channel: manualChannel('direct') } as unknown as Parameters<typeof send>[1]
    await expect(send({ commands: { withSignal: () => ({ run: async () => '' }) } } as unknown as Parameters<typeof send>[0], message)).resolves.toBe('sent')
  })
})
