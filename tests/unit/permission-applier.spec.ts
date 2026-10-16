/**
 * Where this channel's configured permission preset is recorded.
 *
 * The service is read through `ctx.get` rather than declared in `inject`, and
 * that is the whole reason this factory exists as its own seam: the permission
 * service **throws at construction** when the mounted executor does not confine
 * ("the mounted bash executor does not confine (no sandboxMode)"), so a
 * deployment can legitimately compose none. Declaring it in `inject` would park
 * this plugin's row there and the channel would never start.
 *
 * The failure policy is the other half. Applying a preset happens inside session
 * creation, where a throw would abort the creation of a session the user is
 * waiting on and cost them their reply - so a rejection is reported and the
 * session keeps the composition's default instead.
 */

import { describe, expect, it, vi } from 'vitest'
import { permissionApplierOf } from '../../src/index.ts'

/** A context whose `get` answers for the permission service. */
function ctxOf(value: unknown) {
  return { get: (name: string) => (name === 'permissionPresets' ? value : undefined) } as never
}

describe('recording a preset on a new session', () => {
  it('records the configured preset on the session', () => {
    const set = vi.fn()
    const session = { id: 's' }
    const apply = permissionApplierOf(ctxOf({ set }), 'read-only', vi.fn())

    apply?.({ agent: { session } })

    expect(set).toHaveBeenCalledWith(session, 'read-only')
  })

  it('adds nothing when the deployment composes no permission service', () => {
    // The headless composition is the case: no confining executor means no
    // permission service, and the channel must still run.
    expect(permissionApplierOf(ctxOf(undefined), 'read-only', vi.fn())).toBeUndefined()
  })

  it('skips a handle with no session, rather than passing undefined on', () => {
    // The real registry always supplies one, but the map's contract types it as
    // optional. Passing `undefined` to `set` would record a knob on nothing.
    const set = vi.fn()
    const apply = permissionApplierOf(ctxOf({ set }), 'read-only', vi.fn())

    apply?.({ agent: {} })

    expect(set).not.toHaveBeenCalled()
  })

  it('reports a refusing service instead of throwing into session creation', () => {
    // A throw here would abort the creation of a session the user is waiting on,
    // leaving them with no reply at all - worse than running on the default.
    const report = vi.fn()
    const set = vi.fn(() => { throw new Error('unknown preset "read-only"') })
    const apply = permissionApplierOf(ctxOf({ set }), 'read-only', report)

    expect(() => apply?.({ agent: { session: { id: 's' } } })).not.toThrow()
    expect(report).toHaveBeenCalledWith(
      'permission preset not applied; the session keeps its default',
      { preset: 'read-only', error: expect.stringContaining('unknown preset') },
    )
  })
})
