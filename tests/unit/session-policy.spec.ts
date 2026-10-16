/**
 * The channel's own model and permission policy.
 *
 * Both settings exist because the profile's defaults are the *profile's*: the GUI
 * Models page writes the global model, and the permission control writes the
 * global preset. Neither can express "WeChat runs with this model" or "WeChat
 * runs read-only". These two functions are the arithmetic that turns this
 * plugin's own config into the values the agent registry and the permission
 * service take.
 *
 * Every refusal here is deliberate and is asserted as a throw rather than a
 * silent repair: the alternative - guessing the missing half of a provider/model
 * pair, or ignoring an unknown preset - produces a session that runs on a route
 * nobody chose, which is far harder to notice than a failed boot.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PERMISSION,
  PERMISSION_PRESETS,
  resolveModelSelection,
  resolvePermission,
} from '../../src/channel/session-policy.ts'

const FALLBACK = { provider: 'deepseek-official', model: 'deepseek-flash' }

describe('the model a WeChat session runs', () => {
  it('follows the profile default when this plugin configures nothing', () => {
    // The pass-through is what a user who never opened the page gets, so the
    // plugin must not pin a model on their behalf.
    expect(resolveModelSelection({ provider: '', model: '' }, FALLBACK)).toEqual(FALLBACK)
  })

  it('uses the configured pair when one is set', () => {
    expect(resolveModelSelection({ provider: 'p', model: 'm' }, FALLBACK)).toEqual({ provider: 'p', model: 'm' })
  })

  it('trims before deciding whether a field is set', () => {
    // A field left holding only spaces is the same gesture as clearing it.
    expect(resolveModelSelection({ provider: '   ', model: '' }, FALLBACK)).toEqual(FALLBACK)
    expect(resolveModelSelection({ provider: ' p ', model: ' m ' }, FALLBACK)).toEqual({ provider: 'p', model: 'm' })
  })

  it('refuses a half-filled pair instead of repairing it', () => {
    // Taking the configured model while keeping the profile's provider would run
    // that model against a route it does not belong to; keeping the profile's
    // model while taking the configured provider silently ignores the edit. Both
    // are worse than refusing.
    expect(() => resolveModelSelection({ provider: 'p', model: '' }, FALLBACK)).toThrow(/must be set together/u)
    expect(() => resolveModelSelection({ provider: '', model: 'm' }, FALLBACK)).toThrow(/must be set together/u)
  })
})

describe('the permission preset a WeChat session runs', () => {
  it('offers exactly the three presets the base bundle configures', () => {
    expect(PERMISSION_PRESETS).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
  })

  it('defaults to workspace-write, which keeps the approval cards working', () => {
    // The default matters more than usual here: `danger-full-access` bundles
    // `approval: never`, which the approval service settles before the waterfall
    // this plugin's cards listener joins - so it would disable the confirmation
    // mechanism this plugin depends on. A default must never do that.
    expect(DEFAULT_PERMISSION).toBe('workspace-write')
    expect(resolvePermission(DEFAULT_PERMISSION)).toBe('workspace-write')
  })

  it('accepts every offered preset', () => {
    for (const preset of PERMISSION_PRESETS) expect(resolvePermission(preset)).toBe(preset)
  })

  it('refuses a name it does not offer', () => {
    // A profile can hold a value written by another version. Left unchecked, the
    // failure surfaces as `permissionPresets.set` throwing once a message
    // arrives - far from the config that caused it.
    expect(() => resolvePermission('auto')).toThrow(/permission must be one of/u)
    expect(() => resolvePermission('')).toThrow(/permission must be one of/u)
  })

  it('does not accept the derived and reserved preset names', () => {
    // `custom` is a derived value and `auto` is reserved by the permission
    // service; neither is a configurable preset, and treating either as one
    // would write a value the service rejects.
    for (const name of ['custom', 'auto']) expect(() => resolvePermission(name)).toThrow()
  })
})
