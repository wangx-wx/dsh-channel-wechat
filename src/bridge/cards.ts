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
export const APPROVAL_OPTIONS = ['once', 'reject', 'session'] as const

/** One approval choice, as the user may type it. */
export type ApprovalChoice = (typeof APPROVAL_OPTIONS)[number]

/**
 * Render one pending card as the text to send.
 *
 * The number is the card's id, so replying with it names one card even when
 * several are open at once - which is the common case, because tool calls run in
 * parallel.
 *
 * `position` is how a run of cards presents itself now that they are shown one
 * at a time: a user who answers and immediately gets another card needs to know
 * whether that was the last one.
 * @param card - the card to render.
 * @param position - where this card sits in the run, when more than one waits.
 * @returns the message text.
 */
export function formatCard(card: PendingCard, position?: CardPosition): string {
  return card.kind === 'approval' ? formatApproval(card, position) : formatQuestion(card, position)
}

/** Where one card sits in the run of cards waiting for its peer. */
export interface CardPosition {
  /** One-based position of this card. */
  readonly index: number
  /** How many cards the run holds in total. */
  readonly total: number
}

/**
 * The heading suffix naming a card's place in the run.
 *
 * Empty for a lone card: "1/1" on every single approval would be noise, and a
 * lone card is the ordinary case.
 * @param position - where the card sits, when it was given one.
 * @returns the suffix to append to a heading, possibly empty.
 */
function positionSuffix(position: CardPosition | undefined): string {
  if (position === undefined || position.total <= 1) return ''
  return `（第 ${String(position.index)}/${String(position.total)} 张）`
}

/**
 * Render an approval card.
 *
 * The tool name and reason come from the request rather than being invented, so
 * the user decides with the same information the GUI card would show them.
 * @param card - the approval card to render.
 * @returns the message text.
 */
function formatApproval(card: PendingCard, position?: CardPosition): string {
  const lines = [
    `🔒 需要权限确认${positionSuffix(position)}`,
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
    // The id alone is not a reply - the parser requires a choice after it - so
    // the instruction carries the choice too. A card that taught `回复：P1` on its
    // own was telling the user to send something it would not accept.
    `回复：${card.id} 1`,
  )
  return clamp(lines.join('\n'))
}

/** The Chinese explanation of one approval choice. */
function describeApproval(choice: ApprovalChoice): string {
  switch (choice) {
    case 'once': return '仅允许这一次'
    case 'reject': return '拒绝这次调用'
    case 'session':
      // Both halves are required. `danger-full-access` bundles `approval:
      // never`, so choosing this removes the cards for the rest of the
      // conversation; a label that only said "full access" would hide that.
      // There is no second confirmation on this surface, so the loss and the
      // way back are stated here.
      return '本会话全部权限（之后不再弹审批卡，/new 恢复）'
  }
}

/**
 * Render a question card.
 *
 * Every option is numbered, and an all-number reply names options. Anything
 * else is the user's own words for that question, which is why the card says so:
 * an option list reads as a closed set unless it is told otherwise.
 *
 * `0` is the card's own way out into conversation rather than a question's
 * option, so it is numbered below every question's own numbering and can never
 * collide with one.
 * @param card - the question card to render.
 * @param position - where this card sits in the run, when more than one waits.
 * @returns the message text.
 */
function formatQuestion(card: PendingCard, position?: CardPosition): string {
  const lines = [`❓ 需要你确认${positionSuffix(position)}`]
  const multiple = card.questions.length > 1
  card.questions.forEach((question, index) => {
    if (index > 0) lines.push('')
    if (question.header !== undefined && question.header.trim() !== '') {
      lines.push(`【${question.header.trim()}】`)
    }
    // Numbered only when there is more than one, so a single question reads
    // without ceremony but a multi-question card stays addressable.
    const prefix = multiple ? `${String(index + 1)}. ` : ''
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
    if (question.options !== undefined && question.options.length > 0) {
      if (question.multiSelect ?? false) lines.push('  （可多选，用逗号分隔编号）')
      // Said on every question that offers options, because it is a rule about
      // the reply and not a property of this particular question.
      lines.push('  （也可直接写你自己的答案）')
    }
  })
  lines.push('', '0. 换成对话 — 作废本卡，直接说你的想法')
  lines.push('', ...questionReplyHint(card, multiple))
  return clamp(lines.join('\n'))
}

/**
 * The reply syntax line, taught with the delimiters the parser accepts.
 *
 * A multi-question card that mixed words and numbers cannot be answered with
 * bare spaces, so the hint names the separators in the order they are tried.
 * @param card - the card being rendered.
 * @param multiple - whether the card asks more than one question.
 * @returns the lines to append.
 */
function questionReplyHint(card: PendingCard, multiple: boolean): string[] {
  if (!multiple) return [`回复：${card.id} 1`]
  const count = String(card.questions.length)
  return [
    `回复：${card.id} ${Array.from({ length: card.questions.length }, (_, index) => String(index + 1)).join(' | ')}`,
    `（每题的答案用 | 分隔，电脑上也可一行一题，共 ${count} 题）`,
  ]
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
  /**
   * Everything after the id, exactly as typed.
   *
   * `selections` cannot carry a written answer: it splits on whitespace, which
   * turns "use a softer blue" into four tokens. An answer that may be prose is
   * read from here instead, so the whitespace is still available to the
   * question parser.
   */
  raw: string
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
  // The id is the first word, so what follows it starts after exactly that much
  // of the trimmed text. Newlines are preserved here on purpose: they are one
  // of the separators a multi-question answer may use.
  const raw = trimmed.slice(head.length).trim()
  return { cardId, selections, raw }
}

/** What one approval reply means, or why it is not usable. */
export type ApprovalReply =
  | { readonly kind: 'decided'; readonly outcome: 'allowed-once' | 'rejected' }
  /**
   * A grant that also switches the session to full access.
   *
   * Distinct from `decided` because the caller has more to do than return an
   * outcome: it has to change the session's permission, and it has to tell the
   * user the cards will stop appearing. Folding this into `decided` would make
   * that step easy to skip silently.
   */
  | { readonly kind: 'elevate' }
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
  if (choice === 'session') return { kind: 'elevate' }
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
  /**
   * The user chose to talk the decision through instead of deciding.
   *
   * Distinct from `invalid` because the card is over: the turn ends, and the
   * user's next ordinary message is what carries their thinking. Treating it as
   * invalid would keep the card open and re-ask a question they just declined
   * to answer from a menu.
   */
  | { readonly kind: 'discuss' }
  | { readonly kind: 'invalid'; readonly text: string }

/**
 * Read a question reply.
 *
 * **Numbers choose, anything else is written.** A segment made only of option
 * numbers names those options; any other segment is the user's own answer for
 * that question. This is the whole rule, and it is what makes a third choice
 * expressible at all.
 *
 * **One segment per question.** Newlines are tried first because a computer's
 * keyboard can send them, then `|` because a phone's return key is its send
 * button, then bare whitespace for the numbered form. The first split that
 * yields one segment per question wins.
 *
 * Either every question is answered or none is, because a partial answer would
 * leave the model with a half-filled shape it cannot act on.
 * @param card - the card being answered.
 * @param selections - the whitespace-split tokens after the card id.
 * @param raw - the reply after the card id, exactly as typed; `undefined` falls
 *   back to `selections`, which cannot carry a written answer.
 * @returns the answers to return from the listener, an intent to discuss, or an
 *   explanation to send back.
 */
export function readQuestionReply(
  card: PendingCard,
  selections: readonly string[],
  raw?: string,
): QuestionReply {
  const text = raw ?? selections.join(' ')
  // The card-level way out. Checked on the whole reply first so `0` is
  // honoured however many questions the card asks.
  if (isDiscussReply(text)) return { kind: 'discuss' }
  const segments = splitQuestionAnswers(text, card.questions.length)
  if (segments === undefined) return invalidQuestion(card.questions.length, card.questions.length)
  // A `0` among several segments means the same thing as a lone `0`: the user
  // wants to discuss. Requiring the exact form would make the intent depend on
  // which syntax they happened to use.
  if (segments.some(segment => isDiscussReply(segment))) return { kind: 'discuss' }

  const answers: QuestionAnswer[] = []
  for (const [index, question] of card.questions.entries()) {
    const segment = segments[index] ?? ''
    const picked = segment.split(/[\s,]+/u).filter(part => part !== '')
    if (picked.length === 0) return invalidQuestion(index, card.questions.length)
    // All numbers is the only shape read as options. A segment of words is the
    // user's answer even on a question that listed options.
    if (!picked.every(part => /^\d+$/u.test(part))) {
      answers.push({ id: question.id, selected: [], custom: segment.trim() })
      continue
    }
    const labels = picked.map(part => question.options?.[Number(part) - 1]?.label)
    if (labels.some(label => label === undefined)) return invalidQuestion(index, card.questions.length)
    if (labels.length > 1 && !(question.multiSelect ?? false)) {
      return invalidQuestion(index, card.questions.length)
    }
    if (labels.length === 0) return invalidQuestion(index, card.questions.length)
    answers.push({ id: question.id, selected: labels as string[] })
  }
  return { kind: 'answered', answers }
}

/**
 * Whether a reply is the card-level "let us discuss this" choice.
 *
 * Exact, not a prefix: `0.5 seconds` is a written answer that happens to start
 * with a zero, and reading it as the discuss option would throw the answer away.
 * @param text - the reply, or one of its per-question segments.
 * @returns whether the user asked to discuss instead.
 */
function isDiscussReply(text: string): boolean {
  return text.trim() === '0'
}

/**
 * Cut a reply into one segment per question.
 *
 * The separators are tried in the order a person produces them: a newline from
 * a real keyboard, then the bar a phone can type, then plain whitespace for the
 * all-numbered form. A split that does not produce exactly one segment per
 * question is not the right one - a written answer may itself contain any of
 * these separators.
 * @param text - the reply after the card id.
 * @param count - how many questions the card asks.
 * @returns the segments, or `undefined` when no separator lines up.
 */
function splitQuestionAnswers(text: string, count: number): string[] | undefined {
  const trimmed = text.trim()
  if (count === 1) return trimmed === '' ? undefined : [trimmed]
  const separators: readonly RegExp[] = [/\r?\n/u, /\|/u, /\s+/u]
  for (const separator of separators) {
    const parts = trimmed.split(separator)
    // A trailing separator produces an empty tail that is not a question's
    // answer; anything else empty means this split misreads the reply.
    const cleaned = parts.length > count && parts[parts.length - 1] === ''
      ? parts.slice(0, -1)
      : parts
    if (cleaned.length === count && cleaned.every(part => part.trim() !== '')) {
      return cleaned.map(part => part.trim())
    }
  }
  return undefined
}

/** The reply for a question answer nobody can act on. */
function invalidQuestion(index: number, total: number): QuestionReply {
  const which = total > 1 ? `第 ${String(index + 1)} 题的` : ''
  const how = total > 1
    ? `请回复卡片编号和每题的答案，例如「P1 1 | 2」，共 ${String(total)} 题。`
    : '请回复卡片编号和选项编号，例如「P1 1」。'
  return { kind: 'invalid', text: `请回复卡片编号和${which}答案。${how}` }
}

/** One card as the channel holds it, re-exported for callers that render. */
export type { CardKind, PendingCard }
