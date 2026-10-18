/**
 * `/models` and `/model`: what this deployment can run, and which one it uses.
 *
 * Both read the live LLM registry rather than a list in this package, for the
 * reason {@link ../channel/model-catalog} gives: a hardcoded list goes stale the
 * moment a provider is added, removed, or configured out, and it would offer a
 * model the registry then refuses to run.
 *
 * **`/model` writes the plugin's own config, not the harness default.** The two
 * are different stores: this plugin's `provider`/`model` fields are what a new
 * session reads once, at creation, while the harness default is what the GUI's
 * own new sessions read. Writing this plugin's fields is therefore the narrow
 * change - a switch here cannot move the GUI's model out from under its user.
 * The cost is that the peer's *current* session keeps the model it recorded,
 * which is why the reply names `/new`.
 *
 * @module dsh-channel-wechat/bridge/model-commands
 */

import type { CommandOutcome } from './commands.ts'

/** One selectable model, as the catalogue reports it. */
export interface ModelChoice {
  /** Provider route, as `AgentOptions.provider` takes it. */
  readonly provider: string
  /** Model id, as `AgentOptions.model` takes it. */
  readonly model: string
  /** The provider's own name for the model. */
  readonly label: string
  /** Which provider this row belongs to, for grouping. */
  readonly providerLabel: string
}

/** The catalogue `/models` renders. */
export interface ModelListing {
  /** Selectable rows in provider order, then the provider's own order. */
  readonly options: readonly ModelChoice[]
  /** Providers whose models could not be listed, with why. */
  readonly failures: readonly { readonly provider: string; readonly message: string }[]
}

/** What the model commands need from the channel. */
export interface ModelCommandContext {
  /** The live catalogue, or `undefined` when this deployment has no LLM registry. */
  listModels: (() => Promise<ModelListing>) | undefined
  /**
   * Persist a selection into this plugin's config.
   *
   * Rejects when the write cannot even be attempted. A write that fails later -
   * after the config editor's reload has started - is reported to the log
   * instead, because awaiting it here deadlocks: the reload disposes this run,
   * and this run's teardown waits for the command that is waiting for the write.
   */
  switchModel: ((selection: { provider: string; model: string }) => Promise<void>) | undefined
  /** The provider and model this plugin currently has configured. */
  current: () => { provider: string; model: string }
}

/**
 * Render the catalogue.
 *
 * One entry per paragraph, separated by a blank line: WeChat renders the text as
 * markdown, where a single newline collapses into a space. A provider heading and
 * its models therefore need a blank line between every row, not just between
 * groups.
 *
 * @param ctx - the model command context.
 * @returns the listing.
 */
export async function listModels(ctx: ModelCommandContext): Promise<CommandOutcome> {
  const list = ctx.listModels
  if (list === undefined) {
    return { kind: 'error', text: '当前部署没有模型目录，无法列出可用模型。' }
  }

  const catalog = await list()
  const current = ctx.current()
  const lines: string[] = ['可用的供应商与模型：']

  // Grouped by provider, in the order the registry returned them, so the
  // listing reads the way the GUI's selector is organised.
  const byProvider = new Map<string, ModelChoice[]>()
  for (const option of catalog.options) {
    const rows = byProvider.get(option.provider) ?? []
    rows.push(option)
    byProvider.set(option.provider, rows)
  }

  for (const [provider, rows] of byProvider) {
    lines.push('', rows[0]?.providerLabel ?? provider)
    for (const row of rows) {
      const marker = row.provider === current.provider && row.model === current.model ? '（当前）' : ''
      lines.push('', `/${row.provider}/${row.model} — ${row.label}${marker}`)
    }
  }

  // A provider that could not answer is named rather than omitted: a selector
  // missing the provider the user configured and one with no models at all look
  // identical on screen, and only one of them is the user's mistake.
  for (const failure of catalog.failures) {
    lines.push('', `⚠️ ${failure.provider} 无法列出模型：${failure.message}`)
  }

  lines.push(
    '',
    `当前插件配置：${current.provider === '' && current.model === '' ? '跟随 profile 默认' : `${current.provider}/${current.model}`}`,
    '',
    '切换用法：/model <provider/model>',
  )
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * Switch this plugin's configured model.
 * @param ctx - the model command context.
 * @param args - everything after the command name.
 * @returns the outcome to send back.
 */
export async function switchModel(ctx: ModelCommandContext, args: string): Promise<CommandOutcome> {
  const target = parseTarget(args)
  if (target === undefined) {
    return {
      kind: 'error',
      text: '用法：`/model <provider/model>`，例如 `/model deepseek-official/deepseek-v4-pro`。先用 `/models` 查看可用项。',
    }
  }

  const switchTo = ctx.switchModel
  if (switchTo === undefined) {
    return { kind: 'error', text: '当前部署没有可写的插件配置，无法切换模型。' }
  }

  // Validated against the live catalogue before anything is written: a typo is
  // the failure this catches, and it is exactly the failure that would
  // otherwise be invisible - the write's own errors go to the log, not the chat.
  const list = ctx.listModels
  if (list !== undefined) {
    const catalog = await list()
    const known = catalog.options.some(row => row.provider === target.provider && row.model === target.model)
    if (!known) {
      return {
        kind: 'error',
        text: `没有 ${target.provider}/${target.model} 这个可用的模型。用 \`/models\` 查看可用项。`,
      }
    }
  }

  await switchTo(target)

  return {
    kind: 'success',
    text: [
      `已把插件模型切换为 ${target.provider}/${target.model}。`,
      '',
      '写入配置会重启微信通道，所以下一条消息就会用新模型，不必 `/new`；',
      '正在生成的那条回复仍由切换前的模型完成。',
    ].join('\n'),
  }
}

/**
 * Read `<provider>/<model>` out of the command's arguments.
 *
 * The provider is matched against the catalogue only later, so this accepts any
 * two non-empty halves and lets the caller refuse an unknown pair with a message
 * that names what it saw.
 *
 * @param args - everything after the command name.
 * @returns the pair, or `undefined` when the line does not name one.
 */
export function parseTarget(args: string): { provider: string; model: string } | undefined {
  const text = args.trim()
  if (text === '') return undefined
  const slash = text.indexOf('/')
  if (slash <= 0 || slash === text.length - 1) return undefined
  const provider = text.slice(0, slash).trim()
  const model = text.slice(slash + 1).trim()
  // A second separator means the user named something this grammar cannot read;
  // silently taking the first slash would address a different model than typed.
  if (provider === '' || model === '' || model.includes('/')) return undefined
  return { provider, model }
}
