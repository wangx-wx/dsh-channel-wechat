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
import { permissionApplierOf, sessionElevatorOf } from '../../src/index.ts'

/** A context whose `get` answers for the permission service. */
function ctxOf(value: unknown, agents?: unknown) {
  return {
    get: (name: string) => {
      if (name === 'permissionPresets') return value
      if (name === 'agents') return agents
      return undefined
    },
  } as never
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

describe('widening an existing session from a card', () => {
  /** A registry whose live agent for `id` carries `session`. */
  const registryOf = (id: string, session: unknown) => ({
    get: (queried: string) => (queried === id ? { id, session } : undefined),
  })

  it('records full access on the live session the card belongs to', () => {
    // The card carries a session *id*, and `permissionPresets.set` takes the
    // session object. Resolving it through the agent registry is what keeps
    // this from widening some other session - or none at all.
    const set = vi.fn()
    const session = { id: 'channel-wechat-user-7' }
    const elevate = sessionElevatorOf(ctxOf({ set }, registryOf('channel-wechat-user-7', session)), vi.fn())

    expect(elevate('channel-wechat-user-7')).toBe(true)
    expect(set).toHaveBeenCalledWith(session, 'danger-full-access')
  })

  it('reports a session that is no longer live instead of claiming success', () => {
    // The turn may have ended between the card being sent and answered. The
    // user still needs to know the choice did not take effect.
    const set = vi.fn()
    const elevate = sessionElevatorOf(ctxOf({ set }, registryOf('other', { id: 'other' })), vi.fn())

    expect(elevate('channel-wechat-user-7')).toBe(false)
    expect(set).not.toHaveBeenCalled()
  })

  it('reports a service that refuses, without throwing into the answer path', () => {
    // A throw here would leave the card's answer half-applied: the turn was
    // already released, and the user would get no message at all.
    const report = vi.fn()
    const set = vi.fn(() => { throw new Error('unknown preset "danger-full-access"') })
    const elevate = sessionElevatorOf(ctxOf({ set }, registryOf('s', { id: 's' })), report)

    expect(elevate('s')).toBe(false)
    expect(report).toHaveBeenCalledWith(
      'permission preset not applied; the session keeps its default',
      { preset: 'danger-full-access', error: expect.stringContaining('unknown preset') },
    )
  })

  it('answers false when the deployment composes no permission service', () => {
    const elevate = sessionElevatorOf(ctxOf(undefined, registryOf('s', { id: 's' })), vi.fn())

    expect(elevate('s')).toBe(false)
  })
})
