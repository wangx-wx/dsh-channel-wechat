/**
 * Splitting one long answer into messages a chat client will accept.
 *
 * The transport sends one text item per call, and the server refuses a body past
 * its own limit - so an answer longer than that limit would be lost entirely
 * rather than truncated in a way anyone could notice. `docs/design.md` lists
 * message splitting as a v1 requirement; this is it.
 *
 * Two rules shape the cut:
 *
 * **Break where the author broke.** A split inside a sentence reads as a typo,
 * so the cut prefers a paragraph boundary, then a line, then a sentence, and
 * only then a hard cut.
 *
 * **Leave every piece renderable.** A code fence closed in one message and
 * reopened in the next renders as broken text on both sides, so a fence that the
 * cut passes through is closed at the end of the piece and reopened at the start
 * of the next.
 *
 * @module dsh-channel-wechat/bridge/split
 */

/**
 * The default per-message ceiling, in characters.
 *
 * The protocol document does not state a limit, and the reference implementations
 * disagree (4000 in one, 2000 in another). 2000 is the conservative reading: it
 * stays under both, and a long answer split into two readable messages is better
 * than one refused message.
 */
export const DEFAULT_MAX_CHARS = 2_000

/** Where a cut may fall, best first. */
const BREAK_PATTERNS: readonly RegExp[] = [
  /\n\n+/gu, // paragraph
  /\n/gu, // line
  /[。！？!?；;]/gu, // sentence, CJK and Latin
  /[，,、]/gu, // clause
  /\s+/gu, // word
]

/** A fence marker, matched at a line start so inline backticks are ignored. */
const FENCE_LINE = /(?:^|\n)[ \t]*```/gu

/**
 * Split one reply into messages of at most `maxChars`.
 *
 * Returns the input unchanged when it already fits, so a caller does not have to
 * special-case the ordinary short reply.
 * @param text - the reply to send.
 * @param maxChars - per-message ceiling; defaults to {@link DEFAULT_MAX_CHARS}.
 * @returns one or more non-empty messages, in order.
 */
export function splitMessage(text: string, maxChars: number = DEFAULT_MAX_CHARS): string[] {
  if (maxChars <= 0 || text.length <= maxChars) return text.trim() === '' ? [] : [text]

  const parts: string[] = []
  let rest = text
  while (rest.length > maxChars) {
    const cut = findCut(rest, maxChars)
    // A cut at zero would leave `rest` unchanged and loop forever. `findCut`
    // cannot return it, but a guard here is what keeps a future change to the
    // break patterns from turning a wrong answer into a hang.
    const safe = cut > 0 && cut <= rest.length ? cut : maxChars
    const head = rest.slice(0, safe).trimEnd()
    if (head !== '') parts.push(head)
    rest = rest.slice(safe).trimStart()
  }
  if (rest !== '') parts.push(rest)
  return balanceFences(parts)
}

/**
 * The index to cut `text` at, at or before `maxChars`.
 *
 * Scans the break patterns in order of readability and takes the last candidate
 * that still leaves a usable first message. A message shorter than a third of the
 * window is a fragment rather than a reply, so a break before that point is
 * skipped in favour of the next pattern.
 * @param text - the text to cut.
 * @param maxChars - the ceiling.
 * @returns a cut index in `(0, maxChars]`.
 */
function findCut(text: string, maxChars: number): number {
  const window = text.slice(0, maxChars + 1)
  const floor = Math.floor(maxChars / 3)
  for (const pattern of BREAK_PATTERNS) {
    const last = lastMatchEnd(window, pattern)
    if (last !== undefined && last >= floor && last <= maxChars) return last
  }
  return maxChars
}

/** The end index of the last match of `pattern` within `window`, if any. */
function lastMatchEnd(window: string, pattern: RegExp): number | undefined {
  // A fresh stateful scan per call: the shared pattern objects must not keep
  // `lastIndex` between messages.
  let end: number | undefined
  for (const match of window.matchAll(pattern)) {
    end = (match.index ?? 0) + match[0].length
  }
  return end
}

/**
 * Close and reopen code fences that a cut left open.
 *
 * A piece that ends inside a fence gets one appended, and the piece after it gets
 * one prepended. Done as a pass over the finished pieces rather than as a rule
 * inside the cut, because a fence longer than the ceiling cannot be kept whole -
 * the only correct answer there is to close and reopen it, and that is exactly
 * what this does at any depth.
 *
 * @param parts - the pieces, in order.
 * @returns the pieces with fences balanced.
 */
function balanceFences(parts: readonly string[]): string[] {
  const balanced: string[] = []
  let reopen = false
  for (const part of parts) {
    let body = part
    if (reopen) body = `\`\`\`\n${body}`
    const open = fenceCount(body) % 2 === 1
    if (open) body = `${body}\n\`\`\``
    balanced.push(body)
    reopen = open
  }
  return balanced
}

/** How many fence markers the text contains. */
function fenceCount(text: string): number {
  let count = 0
  for (const _match of text.matchAll(FENCE_LINE)) count += 1
  return count
}
