/**
 * Claiming this channel's app argument from the shared command line.
 *
 * `dsh <profile> login` only works if this plugin parses its own app argument:
 * an unclaimed argument is ignored in silence, and the profile boots normally
 * with no login and no error. These tests therefore assert on the claimed
 * values, not merely that parsing did not throw.
 *
 * The claim is now a function rather than a published service, because the row
 * that claims the argument is the same row that acts on it. What the two-row
 * split gave for free - a `--help` invocation publishing nothing, so no server
 * starts - is now the `undefined` return these tests pin.
 */

import { Context } from '@deepseek-ai/cordis'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { describe, expect, it } from 'vitest'
import { claimAppArgument } from '../../src/cmdline.ts'

/** Claim the app argument from a launcher-supplied command line. */
function boot(args: string[]) {
  const ctx = new Context()
  const exits: number[] = []
  provideCmdline(ctx, {
    args,
    exit: (code: number) => void exits.push(code),
    ready: { commit: () => {}, await: async () => {} },
  } as never)

  // Claimed eagerly, not through a thunk: commander requests the exit *during*
  // this call, so a test that read `exits` before calling it would observe an
  // empty list and conclude the invocation was never handled.
  const claimed = claimAppArgument(ctx)
  return { ctx, exits, claimed }
}

describe('command-line entry', () => {
  it('claims a login request when the app argument says login', () => {
    const { claimed } = boot(['login'])

    expect(claimed).toEqual({ action: 'login' })
  })

  it('claims a status request for the status argument', () => {
    const { claimed } = boot(['status'])

    expect(claimed).toEqual({ action: 'status' })
  })

  it('claims an ordinary start when the invocation carries no app arguments', () => {
    // Ordinary boot: the rows that consume this stay dormant, which is what
    // keeps `dsh <profile>` a normal server start.
    const { claimed } = boot([])

    expect(claimed).toEqual({ action: 'none' })
  })

  it('treats an unrecognised word as an ordinary start, not an error', () => {
    // This is a deliberate trade. The command line is shared with every other
    // app in the profile, so a bare word is at least as likely to be their flag
    // value (`--port 19387`) as a typo here. Erroring exits the boot before any
    // service is published, which fails the whole application - so the cost of
    // a silently-ignored typo is accepted instead.
    const { claimed, exits } = boot(['not-a-real-action'])

    expect(exits).toEqual([])
    expect(claimed).toEqual({ action: 'none' })
  })

  it('claims nothing when commander handled the invocation itself', () => {
    // `--help` makes commander write its text and ask the launcher to exit
    // through the `exit` callback. The previous two-row shape got this for free:
    // a startup row that never ran published no service, so the main row stayed
    // dormant. Folding the row in means the claim itself has to say "nobody
    // asked for an action" - otherwise printing help would also start polling.
    const { claimed, exits } = boot(['--help'])

    expect(exits).toEqual([0])
    expect(claimed).toBeUndefined()
  })
})

describe('launcher flags this channel does not own', () => {
  it('ignores the desktop host’s own flags instead of rejecting them', () => {
    // The desktop host boots this profile with `--no-open --port 19387`, which
    // belong to the web app it also mounts. Rejecting them exits the boot
    // before any service is published, which fails the whole app rather than
    // this plugin.
    const { claimed, exits } = boot(['--no-open', '--port', '19387'])

    expect(exits).toEqual([])
    expect(claimed).toEqual({ action: 'none' })
  })

  it('still recognises its own action alongside foreign flags', () => {
    const { claimed, exits } = boot(['--port', '19387', 'login'])

    expect(exits).toEqual([])
    expect(claimed?.action).toBe('login')
  })

  it('does not treat another app’s flag value as an action', () => {
    // The exact shape the desktop host sends: a flag whose value is a bare
    // number. Mistaking it for an action is what crashed the host.
    const { claimed, exits } = boot(['--no-open', '--port', '19387'])

    expect(exits).toEqual([])
    expect(claimed).toEqual({ action: 'none' })
  })
})

describe('the claimed values', () => {
  it('takes `--json` so a script can read a machine-readable result', () => {
    const { claimed } = boot(['login', '--json'])

    expect(claimed?.json).toBe(true)
  })
})
