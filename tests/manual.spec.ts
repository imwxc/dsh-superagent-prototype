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

describe('policy gate on a fresh state', () => {
  // Regression anchor for the omo review P0: the kind's built-in roster must admit the operator on a state
  // where the manual policy part was never stored (a fresh desktop instance), without any seeding.
  it('admits the first manual message as explicit without a stored policy part', async () => {
    const { SettingsSchema } = await import('../src/policy.ts')
    const { SourceRegistry } = await import('../src/sources/registry.ts')
    const { settingsPolicy } = await import('../src/policy.ts')
    const { HealthBoard } = await import('../src/infra/health.ts')
    const registry = new SourceRegistry(() => SettingsSchema.parse({}), new HealthBoard())
    registry.register(manualKind)
    const fresh = SettingsSchema.parse({})
    expect(fresh.policy.sources.manual).toBeUndefined()
    const policy = settingsPolicy(fresh, registry)
    const trigger = manualTrigger('第一条消息', 'chat-9', 'regression-1')
    const thread = { key: 'manual:chat-9', ref: { source: SOURCE, id: 'chat-9' }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {} }
    expect(policy.gate(trigger, thread, [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct' } })
  })
})
