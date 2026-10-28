/**
 * Rendering interaction cards as text, and reading the reply back.
 *
 * Both directions are pure, which is why they are tested here: the interesting
 * failures are all about what a person can be expected to type on a phone, and
 * none of them need a session, a transport, or a running agent to observe.
 */

import { describe, expect, it } from 'vitest'
import {
  APPROVAL_OPTIONS,
  MAX_CARD_CHARS,
  formatCard,
  parseCardReply,
  readApprovalReply,
  readQuestionReply,
} from '../../src/bridge/cards.ts'
import type { PendingCard } from '../../src/bridge/pending-cards.ts'

/** An approval card as the channel would hold it. */
function approval(overrides: Partial<PendingCard> = {}): PendingCard {
  return {
    id: 'P1',
    kind: 'approval',
    peerId: 'user-7',
    sessionId: 'channel-wechat-user-7',
    toolName: 'bash',
    reason: 'run: rm -rf build',
    questions: [],
    ...overrides,
  }
}

/** A question card with the given questions. */
function question(
  questions: PendingCard['questions'],
  overrides: Partial<PendingCard> = {},
): PendingCard {
  return { id: 'P1', kind: 'question', peerId: 'user-7', sessionId: 's', questions, ...overrides }
}

describe('rendering an approval card', () => {
  it('names the tool and the reason the user is deciding on', () => {
    // The whole point of the card is that the user decides with the same facts
    // the GUI card would show. A card that only said "approve?" would be asking
    // them to guess.
    const text = formatCard(approval())

    expect(text).toContain('bash')
    expect(text).toContain('rm -rf build')
  })

  it('offers every choice with the number that answers it', () => {
    const text = formatCard(approval())

    expect(text).toContain('1. once')
    expect(text).toContain('2. reject')
    expect(text).toContain('3. session')
  })

  it('says what the session-wide choice costs and how it ends', () => {
    // The option disables approval cards for the rest of the conversation,
    // because `danger-full-access` bundles `approval: never`. There is no
    // second confirmation on this surface, so the label is the only warning:
    // it has to name both the loss and the way back.
    const text = formatCard(approval())

    expect(text).toContain('之后不再弹审批卡')
    expect(text).toContain('/new')
  })

  it('shows the complete reply the user has to type, not just the id', () => {
    // The defect this exists for, found on a real phone: the card said
    // `回复：P7` while the syntax the parser accepts is `P7 <choice>`. So the one
    // instruction the card gave was not a reply it would accept. Typing `P7`
    // therefore answered nothing, and typing the bare option number `1` was not
    // even recognized as a card reply - it was delivered to the model as an
    // ordinary message and queued behind the very turn that was waiting.
    //
    // Asserting on the id alone cannot see this: `回复：P7` satisfies it.
    const text = formatCard(approval({ id: 'P7' }))

    expect(text).toContain('回复：P7 1')
  })

  it('tells the user the same reply syntax the parser accepts', () => {
    // Tied to the parser rather than restated, so the two can never drift apart
    // again: whatever the card prints must parse into a real decision.
    const card = approval({ id: 'P7' })
    const instructed = /回复：(P\d+ \d)/u.exec(formatCard(card))?.[1]
    const reply = instructed === undefined
      ? undefined
      : parseCardReply(instructed, typed => (typed === 'P7' ? 'P7' : undefined))

    expect(reply).toEqual({ cardId: 'P7', selections: ['1'], raw: '1' })
    expect(readApprovalReply(reply?.selections ?? [])).toEqual({ kind: 'decided', outcome: 'allowed-once' })
  })

  it('prefers the asker\u2019s localized reason when it supplied one', () => {
    const text = formatCard(approval({
      reason: 'raw reason',
      displayReason: 'localized reason',
    }))

    expect(text).toContain('localized reason')
  })

  it('survives an approval that carries no reason at all', () => {
    // `reason` is optional on the seam, so this is a shape that really occurs.
    const text = formatCard(approval())

    expect(text).toContain('bash')
    expect(text).toContain('1. once')
  })

  it('caps a very long reason rather than sending an unbounded message', () => {
    const text = formatCard(approval({ reason: 'x'.repeat(MAX_CARD_CHARS * 2) }))

    expect(text.length).toBeLessThanOrEqual(MAX_CARD_CHARS)
  })
})

describe('rendering a question card', () => {
  it('numbers the options so the answer is a number', () => {
    const text = formatCard(question([
      { id: 'task', question: 'Which mode?', options: [{ label: 'Fast' }, { label: 'Careful' }] },
    ]))

    expect(text).toContain('1. Fast')
    expect(text).toContain('2. Careful')
    expect(text).toContain('Which mode?')
  })

  it('carries each option\u2019s explanation', () => {
    const text = formatCard(question([
      { id: 'q', question: 'Pick', options: [{ label: 'A', description: 'the tradeoff' }] },
    ]))

    expect(text).toContain('the tradeoff')
  })

  it('numbers the questions when there is more than one', () => {
    const text = formatCard(question([
      { id: 'a', question: 'First?' },
      { id: 'b', question: 'Second?' },
    ]))

    expect(text).toContain('1. First?')
    expect(text).toContain('2. Second?')
  })

  it('says so when a question accepts several options', () => {
    const text = formatCard(question([
      { id: 'q', question: 'Pick some', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
    ]))

    expect(text).toMatch(/多选|逗号/u)
  })

  it('renders a question that has no options as free text', () => {
    const text = formatCard(question([{ id: 'q', question: 'What should I name it?' }]))

    expect(text).toContain('What should I name it?')
  })

  it('tells the user a question with options also takes their own words', () => {
    // The option list is not a closed set any more: anything that is not all
    // option numbers is taken as the user's own answer. Nothing on the card
    // said so before, and a user who wanted a third choice had no way to learn
    // that typing it would work.
    const text = formatCard(question([
      { id: 'q', question: 'Which mode?', options: [{ label: 'Fast' }] },
    ]))

    expect(text).toMatch(/自己的答案|直接写/u)
  })

  it('offers the card-level way out into conversation', () => {
    // Choosing to discuss instead of deciding ends the whole card, so the
    // option belongs to the card rather than to any one question. Numbered `0`
    // so it can never collide with a question's own option numbers.
    const text = formatCard(question([
      { id: 'a', question: 'First?', options: [{ label: 'X' }] },
      { id: 'b', question: 'Second?', options: [{ label: 'Y' }] },
    ]))

    expect(text).toContain('0. ')
    expect(text).toMatch(/对话|直接说/u)
  })

  it('says which card this is when several are waiting', () => {
    // Cards are shown one at a time now, so the card has to say where it sits
    // in the run: a user who answers and gets another card needs to know
    // whether that was the last one.
    const text = formatCard(question([{ id: 'q', question: 'Which?' }]), { index: 2, total: 3 })

    expect(text).toContain('2/3')
  })

  it('says nothing about position when it is the only card', () => {
    // A lone card announcing "1/1" is noise, and it is the common case.
    const text = formatCard(question([{ id: 'q', question: 'Which?' }]))

    expect(text).not.toMatch(/\d\/\d/u)
  })
})

describe('recognizing a card reply', () => {
  // Resolves the way the service does: the issued id is canonical, and the
  // typed form is matched against it case-insensitively.
  const open = (typed: string) => (typed.toUpperCase() === 'P1' ? 'P1' : undefined)

  it('reads the id and the chosen numbers', () => {
    expect(parseCardReply('P1 1', open)).toEqual({ cardId: 'P1', selections: ['1'], raw: '1' })
  })

  it('accepts a comma-separated list', () => {
    expect(parseCardReply('P1 1,2', open)).toEqual({ cardId: 'P1', selections: ['1', '2'], raw: '1,2' })
  })

  it('accepts a space-separated list, which is easier on a phone', () => {
    expect(parseCardReply('P1 1 2', open)).toEqual({ cardId: 'P1', selections: ['1', '2'], raw: '1 2' })
  })

  it('reports the issued id, not what the user typed', () => {
    // A phone keyboard capitalizes the first word, so `p1` has to resolve to the
    // issued `P1`. Returning the typed form would make every later lookup miss.
    expect(parseCardReply('p1 1', open)?.cardId).toBe('P1')
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseCardReply('  P1 1 \n', open)?.selections).toEqual(['1'])
  })

  it('does not treat an ordinary message as a reply', () => {
    // This is the failure that would matter most: swallowing prompts as answers
    // would leave the user's real request unanswered.
    expect(parseCardReply('hello world', open)).toBeUndefined()
  })

  it('does not treat a bare number as a reply', () => {
    // `1` alone names no card, so it is a message.
    expect(parseCardReply('1', open)).toBeUndefined()
  })

  it('does not treat a number that names no open card as a reply', () => {
    expect(parseCardReply('P9 1', open)).toBeUndefined()
  })

  it('does not treat a command as a reply', () => {
    expect(parseCardReply('/status', open)).toBeUndefined()
  })

  it('treats an empty message as nothing', () => {
    expect(parseCardReply('   ', open)).toBeUndefined()
  })
})

describe('reading an approval reply', () => {
  it('turns 1 into the one-shot grant', () => {
    // The only value that authorizes anything, so getting it wrong is the
    // difference between a tool running and being refused.
    expect(readApprovalReply(['1'])).toEqual({ kind: 'decided', outcome: 'allowed-once' })
  })

  it('turns 2 into a rejection', () => {
    expect(readApprovalReply(['2'])).toEqual({ kind: 'decided', outcome: 'rejected' })
  })

  it('turns 3 into a session-wide elevation', () => {
    // A distinct kind rather than a second flavour of `decided`: the caller has
    // to change the session's permission as well as allow this call, and a
    // value it could confuse with a plain grant would quietly skip that.
    expect(readApprovalReply(['3'])).toEqual({ kind: 'elevate' })
  })

  it('refuses a number that is offered nowhere', () => {
    expect(readApprovalReply(['4']).kind).toBe('invalid')
  })

  it('refuses two choices at once', () => {
    // A card asks one question; accepting both would be a decision the asker
    // never offered.
    expect(readApprovalReply(['1', '2']).kind).toBe('invalid')
  })

  it('refuses an empty reply', () => {
    expect(readApprovalReply([]).kind).toBe('invalid')
  })

  it('explains what to type when it refuses', () => {
    const reply = readApprovalReply(['9'])

    expect(reply.kind).toBe('invalid')
    if (reply.kind === 'invalid') expect(reply.text).toContain('P1 1')
  })

  it('offers exactly the choices the card renders', () => {
    // The parse and the render have to agree, or the card teaches a reply the
    // reader rejects.
    expect(APPROVAL_OPTIONS).toHaveLength(3)
    expect(readApprovalReply(['1', '2']).kind).toBe('invalid')
  })
})

describe('reading a question reply', () => {
  it('turns an option number into its label', () => {
    const card = question([{ id: 'q', question: 'Pick', options: [{ label: 'Fast' }, { label: 'Careful' }] }])

    expect(readQuestionReply(card, ['2'])).toEqual({
      kind: 'answered',
      answers: [{ id: 'q', selected: ['Careful'] }],
    })
  })

  it('takes free text for a question with no options', () => {
    const card = question([{ id: 'q', question: 'Name it?' }])

    expect(readQuestionReply(card, ['my', 'name'])).toEqual({
      kind: 'answered',
      answers: [{ id: 'q', selected: [], custom: 'my name' }],
    })
  })

  it('answers each question of a multi-question card', () => {
    const card = question([
      { id: 'a', question: 'First?', options: [{ label: 'X' }, { label: 'Y' }] },
      { id: 'b', question: 'Second?', options: [{ label: 'Z' }] },
    ])

    expect(readQuestionReply(card, ['1', '1'])).toEqual({
      kind: 'answered',
      answers: [
        { id: 'a', selected: ['X'] },
        { id: 'b', selected: ['Z'] },
      ],
    })
  })

  it('accepts several options when the question allows it', () => {
    const card = question([
      { id: 'q', question: 'Pick some', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
    ])

    expect(readQuestionReply(card, ['1', '2'])).toEqual({
      kind: 'answered',
      answers: [{ id: 'q', selected: ['A', 'B'] }],
    })
  })

  it('refuses several options when the question allows one', () => {
    const card = question([{ id: 'q', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }])

    expect(readQuestionReply(card, ['1', '2']).kind).toBe('invalid')
  })

  it('refuses an option number that is offered nowhere', () => {
    const card = question([{ id: 'q', question: 'Pick', options: [{ label: 'A' }] }])

    expect(readQuestionReply(card, ['7']).kind).toBe('invalid')
  })

  it('refuses a partial answer to a multi-question card', () => {
    // A half-filled shape leaves the model unable to act, and re-asking is
    // cheaper than asking it to guess.
    const card = question([
      { id: 'a', question: 'First?', options: [{ label: 'X' }] },
      { id: 'b', question: 'Second?', options: [{ label: 'Y' }] },
    ])

    expect(readQuestionReply(card, ['1']).kind).toBe('invalid')
  })

  it('names the question it could not read', () => {
    const card = question([
      { id: 'a', question: 'First?', options: [{ label: 'X' }] },
      { id: 'b', question: 'Second?', options: [{ label: 'Y' }] },
    ])

    const reply = readQuestionReply(card, ['1', '9'])
    expect(reply.kind).toBe('invalid')
    if (reply.kind === 'invalid') expect(reply.text).toContain('第 2 题')
  })
})

describe('answering with your own words', () => {
  // An option list is a suggestion, not a closed set. DSH's answer shape has
  // always carried `custom`, and the GUI's composer has always offered it;
  // only this channel had no way to send one.

  it('takes words in place of an option number', () => {
    const card = question([{ id: 'q', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }])

    expect(readQuestionReply(card, [], 'blue-green')).toEqual({
      kind: 'answered',
      answers: [{ id: 'q', selected: [], custom: 'blue-green' }],
    })
  })

  it('keeps the words whole, spaces and all', () => {
    // The splitter used to cut the reply on whitespace, which would have
    // turned "use a softer blue" into three option numbers and refused it.
    const card = question([{ id: 'q', question: 'Pick', options: [{ label: 'A' }] }])

    expect(readQuestionReply(card, [], 'use a softer blue')).toEqual({
      kind: 'answered',
      answers: [{ id: 'q', selected: [], custom: 'use a softer blue' }],
    })
  })

  it('still reads an all-number answer as the options it names', () => {
    // The one rule that decides between the two readings: numbers are options,
    // anything else is the user's own words. `1 2` on a multi-select must not
    // silently become the custom text "1 2".
    const card = question([
      { id: 'q', question: 'Pick', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
    ])

    expect(readQuestionReply(card, [], '1 2')).toEqual({
      kind: 'answered',
      answers: [{ id: 'q', selected: ['A', 'B'] }],
    })
  })

  it('answers one question per line when the reply has a line per question', () => {
    // A computer's keyboard can send newlines; this is the readable form.
    const card = question([
      { id: 'a', question: 'First?', options: [{ label: 'X' }, { label: 'Y' }] },
      { id: 'b', question: 'Second?', options: [{ label: 'Z' }] },
    ])

    expect(readQuestionReply(card, [], '2\n1')).toEqual({
      kind: 'answered',
      answers: [
        { id: 'a', selected: ['Y'] },
        { id: 'b', selected: ['Z'] },
      ],
    })
  })

  it('falls back to a bar between questions, which a phone can type', () => {
    // A phone's send button is its return key, so the newline form is
    // unreachable there. `|` is the same shape on one line.
    const card = question([
      { id: 'a', question: 'First?', options: [{ label: 'X' }, { label: 'Y' }] },
      { id: 'b', question: 'Second?', options: [{ label: 'Z' }, { label: 'W' }] },
    ])

    expect(readQuestionReply(card, [], '2 | 1')).toEqual({
      kind: 'answered',
      answers: [
        { id: 'a', selected: ['Y'] },
        { id: 'b', selected: ['Z'] },
      ],
    })
  })

  it('mixes a chosen option with written words across questions', () => {
    const card = question([
      { id: 'a', question: 'First?', options: [{ label: 'X' }, { label: 'Y' }] },
      { id: 'b', question: 'Second?', options: [{ label: 'Z' }] },
    ])

    expect(readQuestionReply(card, [], '1 | something else entirely')).toEqual({
      kind: 'answered',
      answers: [
        { id: 'a', selected: ['X'] },
        { id: 'b', selected: [], custom: 'something else entirely' },
      ],
    })
  })

  it('prefers lines over bars when both would split', () => {
    // `a | b` typed on one line is the phone form; a reply that actually has
    // newlines was written deliberately, so lines win.
    const card = question([
      { id: 'a', question: 'First?' },
      { id: 'b', question: 'Second?' },
    ])

    expect(readQuestionReply(card, [], 'east | west\nnorth')).toEqual({
      kind: 'answered',
      answers: [
        { id: 'a', selected: [], custom: 'east | west' },
        { id: 'b', selected: [], custom: 'north' },
      ],
    })
  })

  it('refuses when the segments do not line up with the questions', () => {
    // Handing the model a half-filled shape is worse than asking again.
    const card = question([
      { id: 'a', question: 'First?', options: [{ label: 'X' }] },
      { id: 'b', question: 'Second?', options: [{ label: 'Y' }] },
    ])

    expect(readQuestionReply(card, [], '1 | 2 | 3').kind).toBe('invalid')
  })
})

describe('choosing to discuss instead of deciding', () => {
  it('closes the card when the user answers 0', () => {
    // `0` is the card's own option, not a question's: the user wants to talk
    // the decision through, and every question on this card waits on the same
    // conversation. So the whole card goes, not one question.
    const card = question([
      { id: 'a', question: 'First?', options: [{ label: 'X' }] },
      { id: 'b', question: 'Second?', options: [{ label: 'Y' }] },
    ])

    expect(readQuestionReply(card, [], '0')).toEqual({ kind: 'discuss' })
  })

  it('closes the card when 0 is one of the per-question answers', () => {
    // A user who writes `1 | 0` meant the same thing as `0`: they want to
    // discuss. Honouring it only in the exact `0` reply would make the intent
    // depend on which form they happened to type.
    const card = question([
      { id: 'a', question: 'First?', options: [{ label: 'X' }] },
      { id: 'b', question: 'Second?', options: [{ label: 'Y' }] },
    ])

    expect(readQuestionReply(card, [], '1 | 0')).toEqual({ kind: 'discuss' })
  })

  it('does not mistake a written answer starting with 0 for the discuss option', () => {
    const card = question([{ id: 'q', question: 'How many?', options: [{ label: 'A' }] }])

    expect(readQuestionReply(card, [], '0.5 seconds')).toEqual({
      kind: 'answered',
      answers: [{ id: 'q', selected: [], custom: '0.5 seconds' }],
    })
  })
})
