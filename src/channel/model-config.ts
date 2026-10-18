/**
 * The writable half of `/models` and `/model`.
 *
 * This is the only place the plugin persists a model choice, and it writes the
 * **plugin's own** `provider`/`model` fields - the same two the GUI's settings
 * form writes. It deliberately does not touch the harness default
 * (`ctx.agentDefaultModel`): a WeChat user switching their bot's model must not
 * move the model of the GUI's own new conversations, and those are two different
 * stores with two different owners.
 *
 * ## Why the write is detached
 *
 * A profile edit reloads this plugin's row. The reload disposes the row, and this
 * plugin's disposer awaits `Channel.stop()`, which awaits every in-flight
 * command - including the `/model` call that asked for the edit. Awaiting
 * `edit()` here therefore deadlocks by construction: the write waits for the
 * reload, the reload waits for the command, the command waits for the write.
 *
 * The validation that a user can act on - "is this a model the registry knows" -
 * happens before the write and is awaited, so a typo still gets an answer. What
 * is detached is only the write itself, whose failure the log carries.
 *
 * @module dsh-channel-wechat/channel/model-config
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { ModelCommandContext } from '../bridge/model-commands.ts'
import { buildModelOptions, type LlmCatalogLike } from './model-catalog.ts'

/** The config fields `/model` writes. */
export interface ModelConfigFields {
  /** The configured provider route, empty meaning "follow the profile default". */
  readonly provider: Volatile<string>
  /** The configured model id, empty meaning "follow the profile default". */
  readonly model: Volatile<string>
}

/** The slice of `ctx.configEditor` this module writes through. */
interface ConfigEditorLike {
  edit(
    entry: unknown,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

/**
 * Build the model command surface for one activation.
 *
 * @param ctx - the plugin's cordis context.
 * @param fields - the two config references this activation owns.
 * @param llm - the live registry, or `undefined` when the deployment has none.
 * @param report - where a detached write's failure is recorded.
 * @returns the context `/models` and `/model` run against.
 */
export function createModelCommands(
  ctx: Context,
  fields: ModelConfigFields,
  llm: LlmCatalogLike | undefined,
  report: (message: string, detail?: unknown) => void,
): ModelCommandContext {
  const listModels = llm === undefined ? undefined : async () => await buildModelOptions(llm)

  return {
    listModels,
    current: () => ({ provider: fields.provider.get(), model: fields.model.get() }),
    switchModel: async (selection) => {
      const editor = ctx.get('configEditor') as ConfigEditorLike | undefined
      // No editor means no writable profile: a headless or embedded deployment.
      // Reported rather than silently succeeding, because a command that returns
      // "switched" and changed nothing is worse than one that says it cannot.
      if (editor === undefined) throw new Error('当前部署没有可写的 profile 配置')
      // `Fiber.entry` is declared by `cordis-plugin-loader`, a boot-internal
      // package this plugin does not depend on; importing it for one field
      // would put a loader in this plugin's peer set. Reading the shape locally
      // says the same thing without that dependency - and an absent entry is a
      // real composition (mounted without a Loader), refused below.
      const entry = (ctx.fiber as unknown as { entry?: unknown }).entry
      if (entry === undefined) throw new Error('当前插件没有可写的配置行')

      // Detached on purpose; see the module comment for the deadlock this avoids.
      void editor.edit(entry, (current, inherited) => ({
        ...current,
        provider: selection.provider,
        model: selection.model,
      })).catch((error: unknown) => {
        report('切换模型后写入配置失败', error)
      })
    },
  }
}
