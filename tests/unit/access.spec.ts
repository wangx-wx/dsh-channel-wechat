/**
 * The admission gate as a policy, plus the two facts a deployment needs to
 * explain a refusal.
 *
 * The channel consults it before routing anything, so the rule is verified where
 * it is defined rather than through a session that happens not to answer.
 */

import { describe, expect, it } from 'vitest'
import { createAccessPolicy, parseAllowList } from '../../src/channel/access.ts'

const OWNER = 'o9cq801j8x36C_4pcNTQF6aAqKIg@im.wechat'

describe('reading the configured list', () => {
  it('splits on newlines and commas and drops blanks', () => {
    // One id is the common case and a pasted column is the other; neither should
    // need its own syntax, and a trailing newline must not admit the empty id.
    expect(parseAllowList('a\nb, c\n\n')).toEqual(['a', 'b', 'c'])
  })

  it('reads an absent value as an empty list', () => {
    expect(parseAllowList(undefined)).toEqual([])
  })
})

describe('who is admitted', () => {
  it('admits the user who scanned the login when nothing is configured', () => {
    // The default has to be usable with no configuration at all: the owner's id
    // is already recorded by the login, so requiring them to paste it back would
    // make the safe default also the awkward one.
    const policy = createAccessPolicy({ owner: OWNER })

    expect(policy.allows(OWNER)).toBe(true)
    expect(policy.admitsAnyone()).toBe(true)
  })

  it('refuses everyone else by default', () => {
    // This is the whole point: a second WeChat account must not be able to drive
    // the agent, and the refusal must not depend on the message text.
    const policy = createAccessPolicy({ owner: OWNER })

    expect(policy.allows('stranger@im.wechat')).toBe(false)
    expect(policy.allows('')).toBe(false)
  })

  it('admits exactly the configured ids when a list is set', () => {
    const policy = createAccessPolicy({ owner: OWNER, allow: 'friend-1@im.wechat\nfriend-2@im.wechat' })

    expect(policy.allows('friend-1@im.wechat')).toBe(true)
    expect(policy.allows('friend-2@im.wechat')).toBe(true)
    expect(policy.allows('friend-3@im.wechat')).toBe(false)
  })

  it('treats an explicit list as authoritative, without adding the owner', () => {
    // Silently unioning the owner would make the list on screen disagree with
    // what is actually admitted, which is the kind of gap an operator cannot
    // discover by reading their own configuration.
    const policy = createAccessPolicy({ owner: OWNER, allow: 'friend-1@im.wechat' })

    expect(policy.allows('friend-1@im.wechat')).toBe(true)
    expect(policy.allows(OWNER)).toBe(false)
  })

  it('tolerates whitespace around a configured id', () => {
    // Ids are pasted, and a stray space would otherwise admit nobody while the
    // configuration looked correct.
    const policy = createAccessPolicy({ allow: `  ${OWNER}  ` })

    expect(policy.allows(OWNER)).toBe(true)
  })
})

describe('a deployment with no owner recorded', () => {
  it('admits nobody when the server issued no user id and no list is set', () => {
    // `ilink_user_id` is optional on the wire. Without it there is no way to name
    // the owner implicitly, so failing closed is the only safe answer - and
    // `admitsAnyone` is what lets start-up say so instead of going quiet.
    const policy = createAccessPolicy({})

    expect(policy.allows(OWNER)).toBe(false)
    expect(policy.admitsAnyone()).toBe(false)
  })

  it('still admits a configured list', () => {
    const policy = createAccessPolicy({ allow: 'friend-1@im.wechat' })

    expect(policy.allows('friend-1@im.wechat')).toBe(true)
    expect(policy.admitsAnyone()).toBe(true)
  })
})
