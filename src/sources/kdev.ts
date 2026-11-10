/** KDev source kind: polls merge-request comments in the configured repos and replies as MR comments. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, threadKey, type ChannelRef, type OutboundMessage, type Trigger } from '../core/index.ts'
import { record } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { pause } from './poll.ts'
import type { ChannelLink, SourceKind } from './kind.ts'

export const SOURCE = 'kdev'
/** Read cursor: the newest comment epoch (ms) already ingested; the first run starts at the process start and replays nothing. */
const cursor = record<number>('kdev-cursor')
/** Per-MR `updatedAtTimeStamp` of the last poll; a repo whose newest stamp is unchanged skips its per-MR comment reads. */
const stamps = record<Record<string, number>>('kdev-stamps')
/** The operator's KDev username, learned from `kcli whoami` on the first poll. */
const self = record<string>('kdev-self')
/** A poll window steps back 5 s so late-written comments are not missed; deterministic trigger IDs deduplicate the overlap. */
const OVERLAP_MS = 5_000

const KdevConfigSchema = z.object({
  cli: z.string().min(1).default('kcli'),
  repos: z.array(z.object({ repoId: z.string().regex(/^\d+$/), name: z.string().trim().max(120).optional() }).strict())
    .refine(repos => new Set(repos.map(repo => repo.repoId)).size === repos.length, 'Duplicate repo IDs').default([]),
  /** The mention word that marks a comment as addressed; comments without it never trigger work. */
  mentionWord: z.string().trim().min(2).max(60).default('@superagent'),
  /** The operator's KDev username, whose own comments are skipped; left empty the first poll learns it from `kcli whoami`. */
  self: z.string().trim().max(64).default(''),
  pollSeconds: z.number().int().min(10).max(3600).default(30),
}).strict()
export type KdevConfig = z.infer<typeof KdevConfigSchema>
export { KdevConfigSchema }

/** One MR comment as `kcli kdev mr comments` prints it; the shape was verified against live output on 2026-11-10. */
const CommentSchema = z.looseObject({
  author: z.looseObject({ username: z.string().default('') }),
  createdAt: z.number(),
  details: z.looseObject({ comment: z.looseObject({ body: z.string().default('') }) }),
})
const MrListSchema = z.looseObject({ items: z.array(z.looseObject({
  id: z.number(), title: z.string().default(''), repoName: z.string().default(''),
  sourceBranch: z.string().default(''), updatedAtTimeStamp: z.number().default(0),
})).default([]) })
const CommentPageSchema = z.looseObject({ list: z.array(CommentSchema).default([]) })
const WhoamiSchema = z.looseObject({ loginId: z.string().default('') })

export const kdevTriggerId = (repoId: string, mr: string, commentAt: number): string => key('kdev', `${repoId}/${mr}/${commentAt}`)
/** The reply channel of one merge request; the comment lands on the MR through the operator's kcli identity. */
export const kdevChannel = (repoId: string, mr: string): ChannelRef =>
  ({ source: SOURCE, thread: `kdev:${repoId}:${mr}`, address: { repoId, mr } })
/** Translates one MR comment; only comments that mention the agent trigger work, everything else stays out of the domain. */
export function kdevTrigger(comment: unknown, config: KdevConfig, context: { repoId: string; mr: string; title: string; branch: string }): Trigger | undefined {
  const entry = CommentSchema.parse(comment)
  const username = entry.author.username
  const body = entry.details.comment.body
  if (!username || !body || (config.self !== '' && username === config.self)) return undefined
  if (!body.includes(config.mentionWord)) return undefined
  return { id: kdevTriggerId(context.repoId, context.mr, entry.createdAt), source: SOURCE, threads: [{ source: SOURCE, id: `${context.repoId}:${context.mr}` }],
    actor: { source: SOURCE, id: username }, human: true, addressed: 'mention', at: new Date(entry.createdAt).toISOString(),
    text: body, channel: kdevChannel(context.repoId, context.mr),
    meta: { repoId: context.repoId, mrIid: context.mr, mrTitle: context.title, sourceBranch: context.branch } }
}

/** Web URL of one merge request, used for the thread link in the panel. */
export function kdevMrUrl(repoName: string, mr: string): string {
  return `https://kdev.corp.kuaishou.com/git/${repoName}/-/merge_requests/${mr}`
}

/** Sends one MR comment as the reply; the `mr` address is the MR's web-facing id. */
/**
 * The kcli binary the reply channel calls. `channel.send` receives only the host and message, so the watch loop
 * publishes the configured binary here each cycle; tests arm it with `setKdevCli`.
 */
let sendCli = 'kcli'
export function setKdevCli(cli: string): void { sendCli = cli }
export async function sendKdev(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { repoId, mr } = message.channel.address as { repoId?: string; mr?: string }
  if (!repoId || !mr) throw new Error('Missing KDev reply target')
  await host.commands.run(sendCli, ['kdev', 'mr', 'add-comment', '--repo-id', repoId, '--mr-id', mr, '--discussion-type', 'MR', '--body', message.text])
  return 'sent'
}

/** Reads the configured repos' merge requests and ingests comments newer than the cursor as Triggers. */
export async function pollMrComments(ctx: SourceContext, config: KdevConfig, signal: AbortSignal): Promise<{ read: number; unreadable: number }> {
  if (config.repos.length === 0) return { read: 0, unreadable: 0 }
  const runner = ctx.commands.withSignal(signal)
  const run = async (args: string[]) => runner.run(config.cli, args)
  let operator = config.self || ctx.state.get(self) || ''
  if (operator === '') {
    const who = WhoamiSchema.parse(JSON.parse(await run(['whoami', '--json'])))
    operator = who.loginId
    if (operator) ctx.state.set(self, operator)
  }
  const end = Date.now()
  const floor = Math.max((ctx.state.get(cursor) ?? end) - OVERLAP_MS, 0)
  const known = ctx.state.get(stamps) ?? {}
  const nextStamps: Record<string, number> = {}
  const seen = new Set<string>()
  let read = 0
  let unreadable = 0
  for (const repo of config.repos) {
    const list = MrListSchema.parse(JSON.parse(await run(['kdev', 'mr', 'list', '--repo-id', repo.repoId, '--status', 'opened', '--type', 'ALL', '--page-size', '100', '--json'])))
    // A global comment does not move `commentCount`, so change detection uses each MR's update stamp.
    nextStamps[repo.repoId] = list.items.reduce((max, mr) => Math.max(max, mr.updatedAtTimeStamp), 0)
    if (known[repo.repoId] === nextStamps[repo.repoId]) continue
    for (const mr of list.items) {
      if ((known[`${repo.repoId}:${mr.id}`] ?? 0) >= mr.updatedAtTimeStamp) continue
      const page = CommentPageSchema.parse(JSON.parse(await run(['kdev', 'mr', 'comments', '--repo-id', repo.repoId, '--mr-id', String(mr.id), '--json'])))
      const context = { repoId: repo.repoId, mr: String(mr.id), title: mr.title, branch: mr.sourceBranch }
      for (const comment of page.list) {
        if (comment.createdAt <= floor || comment.createdAt > end) continue
        const identity = `${comment.createdAt}:${comment.author.username}`
        if (seen.has(identity)) continue
        seen.add(identity)
        const trigger = kdevTrigger(comment, config, context)
        if (!trigger) { unreadable += 1; continue }
        await ctx.receive(trigger)
        for (const ref of trigger.threads)
          ctx.threads.describe(threadKey(ref), {
            label: mr.title || 'Merge request',
            url: kdevMrUrl(mr.repoName, context.mr),
            facts: { chat: { label: { zh: '仓库', en: 'Repo' }, value: mr.repoName || repo.repoId }, branch: { label: { zh: '分支', en: 'Branch' }, value: mr.sourceBranch } },
          })
        read += 1
      }
    }
  }
  ctx.state.set(stamps, { ...known, ...nextStamps })
  ctx.state.set(cursor, end)
  return { read, unreadable }
}

/** Configures the KDev Source each cycle and polls; three consecutive failures need a person. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<KdevConfig>(SOURCE)
    if (!config || config.repos.length === 0) { ctx.report(SOURCE, health('paused', 'sourceOff')) }
    else {
      setKdevCli(config.cli)
      try {
        const { read, unreadable } = await pollMrComments(ctx, config, signal)
        failures = 0
        ctx.report(SOURCE, { state: 'ready', detail: `${config.repos.length} repos, ${read} comments, ${unreadable} unreadable`, at: new Date().toISOString() })
      } catch (error) {
        failures += 1
        // One failed poll retries on the next round; three in a row need a person.
        if (!signal.aborted && failures >= 3) ctx.report(SOURCE, health('error', 'pollFailures', { count: String(failures), error: String(error) }))
      }
    }
    await pause((config?.pollSeconds ?? 30) * 1000, signal)
  }
  setKdevCli('kcli')
}

export const kdevKind: SourceKind<KdevConfig> = {
  kind: SOURCE,
  title: { zh: 'KDev', en: 'KDev' },
  description: {
    zh: '轮询下列仓库的 Merge Request 评论（@ 提及词触发），以你的 kcli 身份回复 MR 评论。',
    en: 'Polls merge-request comments in these repos (mention word triggers) and replies as MR comments through your kcli identity.',
  },
  schema: KdevConfigSchema,
  fields: [
    { key: 'cli', type: 'text', label: { zh: 'kcli 命令', en: 'kcli command' },
      hint: { zh: '命令名或绝对路径；以操作者的 KDev 身份读写 MR。', en: 'A command name or absolute path; reads and writes MRs as the operator.' } },
    { key: 'repos', type: 'rows', label: { zh: '监听的仓库', en: 'Repos' },
      hint: { zh: '轮询这些仓库的开启中 MR 的评论；repoId 在 kdev 仓库页可得。', en: 'Polls open-MR comments in these repos; the repoId comes from the kdev repository page.' },
      columns: [
        { key: 'repoId', type: 'text', label: { zh: '仓库 ID', en: 'Repo ID' }, pattern: '\\d+' },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    { key: 'mentionWord', type: 'text', label: { zh: '触发词', en: 'Mention word' },
      hint: { zh: '评论正文包含该词才触发工作（如 @superagent）。', en: 'A comment triggers work only when its body contains this word (e.g. @superagent).' } },
    { key: 'self', type: 'text', advanced: true, label: { zh: '自己的用户名', en: 'Own username' },
      hint: { zh: '跳过自己发出的评论；留空则首次轮询用 kcli whoami 自动学习。', en: 'Skips comments you posted; empty learns it from kcli whoami on the first poll.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 10, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / s' } },
  ],
  health: ['kdev'],
  scope({ meta }, config) {
    const repo = config.repos.find(item => item.repoId === String(meta.repoId))
    return repo ? { listened: true, observed: false, row: repo.repoId } : { listened: false, reason: 'repo_not_listed' }
  },
  // A reply goes only to a merge request the Source still polls.
  channel: {
    allowed: (address, config) => config.repos.some(item => item.repoId === address.repoId),
    send: sendKdev,
    link: (address): ChannelLink => {
      const mr = String(address.mr ?? '')
      return { url: mr === '' ? '' : `https://kdev.corp.kuaishou.com/git/-/merge_requests/${mr}`, label: { zh: 'Merge request', en: 'Merge request' } }
    },
  },
  find: query => ({ threads: [], terms: [...new Set(query.match(/kdev:\d+:\d+/g) ?? [])] }),
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict()).default([]),
    }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 KDev 用户', en: 'KDev users who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '用户名', en: 'Username' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: {
      zh: '名单里的人在监听仓库的 MR 评论里写触发词。执行以 kcli 身份进行，工作区由 prepare 命令克隆 kdev 仓库。',
      en: 'Someone on the list writes the mention word in a watched merge request. Execution runs as kcli; the workspace is cloned by the prepare command.',
    },
    rows(stored) {
      const config = KdevConfigSchema.parse(stored)
      const note = { zh: '触发词', en: 'mention word' }
      return config.repos.map(repo => ({ id: repo.repoId, label: repo.name || repo.repoId, note,
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }))
    },
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_KDEV_REPO', description: {
      zh: '工单来源仓库（group/repo）；工单不是从 KDev 来的时候为空',
      en: 'The source repository (group/repo) of the ticket; empty when the ticket did not start on KDev' } }],
    values: ({ trigger }) => {
      const meta = trigger?.source === SOURCE ? trigger.meta as { repoName?: string; mrIid?: string } : undefined
      return { DSH_SUPERAGENT_KDEV_REPO: meta?.repoName ?? '' }
    },
  },
}

export const name = 'dsh-superagent-kdev'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(kdevKind), 'kdev: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, kdevKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
