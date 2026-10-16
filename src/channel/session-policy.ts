/**
 * What this channel's own configuration says about a session's model and
 * permission.
 *
 * Both settings are *this channel's*, not the profile's. That is the whole
 * point of them: the GUI's Models page owns the global default, and its
 * permission control owns the global default preset, so neither is the right
 * place to say "WeChat runs with a different model" or "WeChat runs read-only".
 *
 * Kept free of cordis and of the agent registry so both halves of that claim can
 * be unit-tested as arithmetic: which selection a pair of config fields resolves
 * to, and which presets this plugin is willing to offer.
 *
 * @module dsh-channel-wechat/channel/session-policy
 */

/**
 * The permission presets a WeChat session may be put on.
 *
 * These are the three the `dsh-base` bundle configures
 * (`packages/bundle/base/cordis.patch.yml`), in widening order, and they are
 * deliberately spelled literally rather than read from
 * `ctx.permissionPresets.catalog()`: the catalog is a live process value, and a
 * config field whose accepted values move with the process would accept a value
 * today and reject it after a restart.
 *
 * `danger-full-access` is offered even though it disables this plugin's own
 * approval cards - the preset bundles `approval: never`, which the approval
 * service settles *before* the waterfall our cards listener joins. The page asks
 * for explicit confirmation for that value; see the spec for the tradeoff.
 */
export const PERMISSION_PRESETS = ['read-only', 'workspace-write', 'danger-full-access'] as const

/** One permission preset name. */
export type PermissionPreset = (typeof PERMISSION_PRESETS)[number]

/** The preset a session is put on when this plugin's config does not say. */
export const DEFAULT_PERMISSION: PermissionPreset = 'workspace-write'

/** A provider and model pair, as the agent registry takes it. */
export interface ModelSelectionLike {
  readonly provider: string
  readonly model: string
}

/** The two config fields this module reads. */
export interface ModelConfigLike {
  /** Configured provider, or empty for "follow the profile default". */
  readonly provider: string
  /** Configured model, or empty for "follow the profile default". */
  readonly model: string
}

/**
 * Resolve the model a session created by this channel should run.
 *
 * An empty pair means "follow the profile's default", which is what a user who
 * never opened this page gets - so the plugin stays a pass-through rather than
 * pinning a model the operator did not choose. A half-filled pair is refused
 * rather than repaired: the agent registry needs both, and silently keeping the
 * profile's provider while taking a configured model would run the configured
 * model against a route it does not belong to.
 *
 * @param config - this plugin's configured provider and model.
 * @param fallback - the profile's current default selection.
 * @returns the selection to pass to the agent registry.
 * @throws when exactly one of the two fields is set.
 */
export function resolveModelSelection(config: ModelConfigLike, fallback: ModelSelectionLike): ModelSelectionLike {
  const provider = config.provider.trim()
  const model = config.model.trim()
  if (provider === '' && model === '') return { provider: fallback.provider, model: fallback.model }
  if (provider === '' || model === '') {
    throw new Error(
      'channel-wechat: provider and model must be set together, '
      + `got provider=${JSON.stringify(config.provider)} model=${JSON.stringify(config.model)}`,
    )
  }
  return { provider, model }
}

/**
 * Read the configured permission preset, refusing a value the schema should have
 * rejected.
 *
 * Checked here as well as in the schema because a profile can hold a value from
 * an older or newer version of this plugin, and the failure it would otherwise
 * cause - `permissionPresets.set` throwing on an unknown preset once a message
 * arrives - is far from the config that caused it.
 *
 * @param value - the configured preset name.
 * @returns the preset to apply.
 * @throws when the name is not one this plugin offers.
 */
export function resolvePermission(value: string): PermissionPreset {
  if ((PERMISSION_PRESETS as readonly string[]).includes(value)) return value as PermissionPreset
  throw new Error(
    `channel-wechat: permission must be one of ${PERMISSION_PRESETS.join(', ')}, got ${JSON.stringify(value)}`,
  )
}
