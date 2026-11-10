import { describe, expect, it } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { record } from '../src/kv.ts'
import {
  KdevConfigSchema, kdevChannel, kdevKind, kdevMrUrl, kdevTrigger, kdevTriggerId, pollMrComments, SOURCE,
} from '../src/sources/kdev.ts'
import type { Key } from '../src/kv.ts'
import type { SourceContext } from '../src/sources/host.ts'

/** A comment stamp inside the first-poll window (`now - OVERLAP_MS`): fixed per call site via `stamp()`. */
const stamp = (offsetMs = 0): number => Date.now() - 1_000 + offsetMs
/** One MR comment in the live shape `kcli kdev mr comments` printed on 2026-11-10. */
const comment = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  author: { username: 'jiangduo03', name: '姜铎', email: '', avatarUrl: '', type: 'person', exist: true },
  authorType: 'human',
  createdAt: stamp(),
  createdAtStr: '1 秒前',
  details: { comment: { version: '', body: '@superagent 帮忙看下这个 MR' } },
  ...over,
})
/** One merge request in the live shape `kcli kdev mr list` prints. */
const mr = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 1816, title: 'feat: DSH 应用 Kim 事件中转', repoName: 'locallife/lfe/cyber-next/cyber-tower-node',
  sourceBranch: 'feat/kim-dsh-relay', commentCount: 4, status: 'opened', author: { username: 'wangxianchen' },
  ...over,
})
const config = KdevConfigSchema.parse({ repos: [{ repoId: '221369', name: 'cyber-tower-node' }], self: 'wangxianchen' })

describe('kdevTrigger', () => {
  it('translates a mentioned comment into the same trigger shape the other sources produce', () => {
    expect(kdevKind.kind).toBe(SOURCE)
    const at = stamp()
    const value = kdevTrigger(comment({ createdAt: at }), config, { repoId: '221369', mr: '1816', title: 'feat: relay', branch: 'feat/x' }) as Trigger
    expect(value).toMatchObject({
      id: kdevTriggerId('221369', '1816', at),
      source: 'kdev', threads: [{ source: 'kdev', id: '221369:1816' }],
      actor: { source: 'kdev', id: 'jiangduo03' }, human: true, addressed: 'mention',
      at: new Date(at).toISOString(),
      text: '@superagent 帮忙看下这个 MR',
      channel: { source: 'kdev', thread: 'kdev:221369:1816', address: { repoId: '221369', mr: '1816' } },
      meta: { repoId: '221369', mrIid: '1816', mrTitle: 'feat: relay', sourceBranch: 'feat/x' },
    })
  })
  it('skips own comments and comments without the mention word, and throws on garbage payloads', () => {
    expect(kdevTrigger(comment({ author: { username: 'wangxianchen' } }), config, { repoId: '221369', mr: '1816', title: 't', branch: 'b' })).toBeUndefined()
    expect(kdevTrigger(comment({ details: { comment: { body: '看这个' } } }), config, { repoId: '221369', mr: '1816', title: 't', branch: 'b' })).toBeUndefined()
    // A comment missing the nested body fails validation loudly, like the other sources' payload schemas.
    expect(() => kdevTrigger({ createdAt: 1, author: {}, details: {} }, config, { repoId: '1', mr: '2', title: '', branch: '' })).toThrow()
    expect(() => kdevTrigger({ token: 'x', info: {} }, config, { repoId: '1', mr: '2', title: '', branch: '' })).toThrow()
  })
})

describe('kdevKind', () => {
  it('defaults its configuration and validates repos', () => {
    const parsed = KdevConfigSchema.parse({})
    expect(parsed).toMatchObject({ cli: 'kcli', mentionWord: '@superagent', self: '', pollSeconds: 30, repos: [] })
    expect(KdevConfigSchema.safeParse({ repos: [{ repoId: 'abc' }] }).success).toBe(false)
    expect(KdevConfigSchema.safeParse({ repos: [{ repoId: '1' }, { repoId: '1' }] }).success).toBe(false)
  })
  it('listens only to listed repos and describes admission rows from them', () => {
    expect(kdevKind.scope!({ meta: { repoId: '221369' } }, config)).toEqual({ listened: true, observed: false, row: '221369' })
    expect(kdevKind.scope!({ meta: { repoId: '42' } }, config)).toEqual({ listened: false, reason: 'repo_not_listed' })
    const registryRows = kdevKind.policy!.rows!(config as Record<string, unknown>)
    expect(registryRows).toEqual([{ id: '221369', label: 'cyber-tower-node', note: { zh: '触发词', en: 'mention word' },
      cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }])
  })
  it('links a merge request and settles replies through kcli', async () => {
    expect(kdevMrUrl('locallife/lfe/cyber-next/cyber-tower-node', '1816'))
      .toBe('https://kdev.corp.kuaishou.com/git/locallife/lfe/cyber-next/cyber-tower-node/-/merge_requests/1816')
    expect(kdevKind.channel!.link({ repoId: '221369', mr: '1816' }, {} as never)).toMatchObject({ label: { zh: 'Merge request', en: 'Merge request' } })
  })
})

/** A minimal SourceContext for `pollMrComments`: canned kcli pages, an in-memory KV, and recorded receives. */
function context(pages: string[]) {
  const state = new Map<string, unknown>()
  const received: Trigger[] = []
  let call = 0
  const value: SourceContext = {
    commands: { withSignal: () => ({ run: async () => pages[call++] ?? '{"items":[]}' }) },
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

describe('pollMrComments', () => {
  it('ingests new mentioned comments and skips own, unmentioned and out-of-window ones', async () => {
    const list = JSON.stringify({ items: [mr()] })
    const base = stamp()
    const comments = JSON.stringify({ list: [
      comment({ createdAt: base }),
      comment({ createdAt: base + 200, author: { username: 'wangxianchen' }, details: { comment: { body: '@superagent 自己的' } } }),
      comment({ createdAt: base + 400, details: { comment: { body: '没带触发词' } } }),
      comment({ createdAt: base + 600 }),
      // Outside the first-poll window (the cursor defaults to now): must not replay.
      comment({ createdAt: Date.now() - 30_000 }),
    ] })
    const { value, received } = context([list, comments])
    const result = await pollMrComments(value, config, new AbortController().signal)
    expect(result).toEqual({ read: 2, unreadable: 2 })
    expect(received.map(item => item.id)).toEqual([kdevTriggerId('221369', '1816', base), kdevTriggerId('221369', '1816', base + 600)])
    expect((value.state.get(record<Record<string, number>>('kdev-counts')) as Record<string, number>)['221369']).toBe(4)
  })
  it('reads a repo again when a new comment raises its count', async () => {
    const list = JSON.stringify({ items: [mr()] })
    const updated = JSON.stringify({ items: [mr({ commentCount: 5 })] })
    const { value, received } = context([list, JSON.stringify({ list: [comment()] }), updated, JSON.stringify({ list: [comment({ createdAt: stamp(300), details: { comment: { body: '@superagent 再看一眼' } } })] })])
    await pollMrComments(value, config, new AbortController().signal)
    const second = await pollMrComments(value, config, new AbortController().signal)
    expect(second).toEqual({ read: 1, unreadable: 0 })
    expect(received).toHaveLength(2)
  })
})
