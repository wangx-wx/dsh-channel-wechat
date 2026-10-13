/**
 * Rendering interaction cards as WeChat text, and reading the reply back.
 *
 * An approval or question request reaches a channel plug-in as a waterfall
 * listener, and the only way to answer is to return a value from it. WeChat has
 * no cards, buttons, or callbacks - only lines of text - so both directions are
 * this module's job: turn a request into something a person can answer by
 * typing, and turn what they typed back into the outcome the listener returns.
 *
 * The rendering is deliberately text-only and numbered. Numbering is what makes
 * the reply unambiguous: a free-text answer to "may I run this tool?" cannot be
 * distinguished from a message the user meant for the model, so the card teaches
 * an exact reply and nothing else is accepted.
 *
 * @module dsh-channel-wechat/bridge/cards
 */

import type { CardKind, PendingCard } from './pending-cards.ts'

/** The maximum length of one card, leaving room inside WeChat's message limit. */
export const MAX_CARD_CHARS = 1_800

/** The option labels an approval card offers, in the order it presents them. */
export const APPROVAL_OPTIONS = ['once', 'reject'] as const

/** One approval choice, as the user may type it. */
export type ApprovalChoice = (typeof APPROVAL_OPTIONS)[number]

/**
 * Render one pending card as the text to send.
 *
 * The number is the card's id, so replying with it names one card even when
 * several are open at once - which is the common case, because tool calls run in
 * parallel.
 * @param card - the card to render.
 * @returns the message text.
 */
export function formatCard(card: PendingCard): string {
  return card.kind === 'approval' ? formatApproval(card) : formatQuestion(card)
}

/**
 * Render an approval card.
 *
 * The tool name and reason come from the request rather than being invented, so
 * the user decides with the same information the GUI card would show them.
 * @param card - the approval card to render.
 * @returns the message text.
 */
function formatApproval(card: PendingCard): string {
  const lines = [
    '🔒 需要权限确认',
    `工具：${card.toolName ?? '(未知)'}`,
  ]
  // The asker's own words, when it supplied any. `displayReason` is a localized
  // presentation copy, so it is preferred over the raw one.
  const reason = card.displayReason ?? card.reason
  if (reason !== undefined && reason.trim() !== '') {
    lines.push('原因：', ...indent(reason.trim()))
  }
  lines.push(
    '',
    '请回复其中一个：',
    ...APPROVAL_OPTIONS.map((choice, index) => `  ${String(index + 1)}. ${choice} — ${describeApproval(choice)}`),
    '',
    `回复：${card.id}`,
  )
  return clamp(lines.join('\n'))
}

/** The Chinese explanation of one approval choice. */
function describeApproval(choice: ApprovalChoice): string {
  return choice === 'once' ? '仅允许这一次' : '拒绝这次调用'
}

/**
 * Render a question card.
 *
 * Every option is numbered, and the reply is an option's number for that
 * question. A question with no options expects free text, which is the only case
 * where an answer is not a number.
 * @param card - the question card to render.
 * @returns the message text.
 */
function formatQuestion(card: PendingCard): string {
  const lines = ['❓ 需要你确认']
  card.questions.forEach((question, index) => {
    if (index > 0) lines.push('')
    if (question.header !== undefined && question.header.trim() !== '') {
      lines.push(`【${question.header.trim()}】`)
    }
    // Numbered only when there is more than one, so a single question reads
    // without ceremony but a multi-question card stays addressable.
    const prefix = card.questions.length > 1 ? `${String(index + 1)}. ` : ''
    lines.push(`${prefix}${question.question}`)
    if (question.detail !== undefined && question.detail.trim() !== '') {
      lines.push(...indent(question.detail.trim()))
    }
    question.options?.forEach((option, optionIndex) => {
      const label = `${String(optionIndex + 1)}. ${option.label}`
      lines.push(option.description === undefined || option.description.trim() === ''
        ? `  ${label}`
        : `  ${label} — ${option.description}`)
    })
    if (question.options !== undefined && question.options.length > 0 && (question.multiSelect ?? false)) {
      lines.push('  （可多选，用逗号分隔编号）')
    }
  })
  lines.push('', `回复：${card.id} 1` + (card.questions.length > 1 ? ' 2 …' : ''))
  return clamp(lines.join('\n'))
}

/** Indent a block, so multi-line details read as part of their label. */
function indent(text: string): string[] {
  return text.split('\n').map(line => `  ${line}`)
}

/** Cap a card at the message limit, saying so rather than cutting silently. */
function clamp(text: string): string {
  if (text.length <= MAX_CARD_CHARS) return text
  return `${text.slice(0, MAX_CARD_CHARS - 20)}\n…（内容过长已截断）`
}

/** One parsed reply: which card, and what the user chose. */
export interface ParsedCardReply {
  /** The card id the reply names. */
  cardId: string
  /** The option numbers the reply selected, in the order given. */
  selections: readonly string[]
}

/**
 * Parse a card reply.
 *
 * The shape is `<cardId> <choice>…`, and nothing else counts as a reply: a bare
 * number, or any other prose, stays an ordinary message for the model. That is
 * deliberate - treating arbitrary text as an answer would silently swallow
 * messages the user meant as prompts.
 *
 * A card id is resolved against the open set rather than matched by pattern, so
 * `3 hello` is a message unless `3` names an open card.
 *
 * The resolver returns the *canonical* id rather than a boolean, which is what
 * keeps case-insensitivity in one place: the user may type `p1` because a phone
 * keyboard capitalizes the first word, while the card was issued as `P1`. The
 * reply carries the id as it was issued, so every later lookup matches.
 *
 * @param text - the message the user sent.
 * @param resolve - map what the user typed to the issued id, or `undefined`.
 * @returns the parsed reply, or `undefined` when this is not one.
 */
export function parseCardReply(
  text: string,
  resolve: (typed: string) => string | undefined,
): ParsedCardReply | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const [head, ...rest] = trimmed.split(/\s+/u)
  if (head === undefined) return undefined
  const cardId = resolve(head)
  if (cardId === undefined) return undefined
  // `P1 1,2` and `P1 1 2` both mean the same thing; a phone's keyboard makes the
  // space form easier, and a comma is how a person writes a list.
  const selections = rest
    .flatMap(part => part.split(','))
    .map(part => part.trim())
    .filter(part => part !== '')
  return { cardId, selections }
}

/** What one approval reply means, or why it is not usable. */
export type ApprovalReply =
  | { readonly kind: 'decided'; readonly outcome: 'allowed-once' | 'rejected' }
  | { readonly kind: 'invalid'; readonly text: string }

/**
 * Read an approval reply.
 * @param selections - the option numbers the user typed.
 * @returns the outcome to return from the listener, or an explanation to send back.
 */
export function readApprovalReply(selections: readonly string[]): ApprovalReply {
  const first = selections[0]
  // Exactly one choice: a card asks one question, and `1 2` is ambiguous rather
  // than an instruction to do both.
  if (first === undefined || selections.length !== 1) return invalidApproval()
  const choice = APPROVAL_OPTIONS[Number(first) - 1]
  if (choice === undefined) return invalidApproval()
  return { kind: 'decided', outcome: choice === 'once' ? 'allowed-once' : 'rejected' }
}

/** The reply for an approval answer nobody can act on. */
function invalidApproval(): ApprovalReply {
  return {
    kind: 'invalid',
    text: `请回复 ${APPROVAL_OPTIONS.map((_, index) => String(index + 1)).join(' 或 ')}（与卡片编号一起发，例如「P1 1」）。`,
  }
}

/** One question's answer, as the answerer shape needs it. */
export interface QuestionAnswer {
  /** The answered question's id. */
  readonly id: string
  /** The labels selected. */
  readonly selected: readonly string[]
  /** Free text, when the question had no options. */
  readonly custom?: string
}

/** What one question reply means, or why it is not usable. */
export type QuestionReply =
  | { readonly kind: 'answered'; readonly answers: readonly QuestionAnswer[] }
  | { readonly kind: 'invalid'; readonly text: string }

/**
 * Read a question reply.
 *
 * A question with options takes option numbers; one without takes the text as
 * typed. Either every question is answered or none is, because a partial answer
 * would leave the model with a half-filled shape it cannot act on.
 * @param card - the card being answered.
 * @param selections - the parts of the reply after the card id.
 * @returns the answers to return from the listener, or an explanation to send back.
 */
export function readQuestionReply(card: PendingCard, selections: readonly string[]): QuestionReply {
  const answers: QuestionAnswer[] = []
  for (const [index, question] of card.questions.entries()) {
    const hasOptions = question.options !== undefined && question.options.length > 0
    if (hasOptions) {
      // With one question the whole reply is its selection; with several, each
      // question has its own token.
      const token = card.questions.length === 1 ? selections.join(' ') : selections[index]
      const picked = (token ?? '').split(/[\s,]+/u).filter(part => part !== '')
      const labels = picked.map(part => question.options?.[Number(part) - 1]?.label)
      if (labels.length === 0 || labels.some(label => label === undefined)) {
        return invalidQuestion(index, card.questions.length)
      }
      if (labels.length > 1 && !(question.multiSelect ?? false)) {
        return invalidQuestion(index, card.questions.length)
      }
      answers.push({ id: question.id, selected: labels as string[] })
    } else {
      const text = (card.questions.length === 1 ? selections.join(' ') : selections[index] ?? '').trim()
      if (text === '') return invalidQuestion(index, card.questions.length)
      answers.push({ id: question.id, selected: [], custom: text })
    }
  }
  return { kind: 'answered', answers }
}

/** The reply for a question answer nobody can act on. */
function invalidQuestion(index: number, total: number): QuestionReply {
  const which = total > 1 ? `第 ${String(index + 1)} 题的` : ''
  return { kind: 'invalid', text: `请回复卡片编号和${which}选项编号，例如「P1 1」。` }
}

/** One card as the channel holds it, re-exported for callers that render. */
export type { CardKind, PendingCard }
