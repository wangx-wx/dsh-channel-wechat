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

/** Appended to a piece that ends inside a fence, to close it. */
const FENCE_CLOSE = '\n```'

/** Prepended to the piece after one that ended inside a fence, to reopen it. */
const FENCE_OPEN = '```\n'

/**
 * Split one reply into messages of at most `maxChars`.
 *
 * Returns the input unchanged when it already fits, so a caller does not have to
 * special-case the ordinary short reply.
 *
 * Fences are accounted for **while** the cut is chosen, not afterwards. Adding a
 * closing marker to a finished piece pushed it past the ceiling, and the
 * transport refuses an over-long body rather than truncating it - so the piece
 * was lost outright.
 * @param text - the reply to send.
 * @param maxChars - per-message ceiling; defaults to {@link DEFAULT_MAX_CHARS}.
 * @returns one or more non-empty messages, in order.
 */
export function splitMessage(text: string, maxChars: number = DEFAULT_MAX_CHARS): string[] {
  if (maxChars <= 0 || text.length <= maxChars) return text.trim() === '' ? [] : [text]

  const parts: string[] = []
  let rest = text
  // Whether the previous piece ended inside a fence, and so this one has to
  // reopen it before its own text. Annotated because the loop feeds it back into
  // the value it is derived from, which TypeScript cannot infer through.
  let reopen: boolean = false
  while (rest !== '') {
    const prefix: string = reopen ? FENCE_OPEN : ''
    // The last piece is the one place the closing marker can be decided before
    // the cut: there is no next piece to carry the fence into, so the rest of
    // the text either fits with its marker or is cut like any other piece.
    const tailClose = fenceCount(`${prefix}${rest}`) % 2 === 1
      && prefix.length + rest.length + FENCE_CLOSE.length <= maxChars
      ? FENCE_CLOSE
      : ''
    if (prefix.length + rest.length + tailClose.length <= maxChars) {
      parts.push(`${prefix}${rest}${tailClose}`)
      break
    }
    // What is left of the window once the reopening fence has taken its share.
    const cut = fitCut(rest, prefix, Math.max(1, maxChars - prefix.length), maxChars)
    const head = rest.slice(0, cut).trimEnd()
    // The ceiling is a hard limit and balancing is not: a configured limit too
    // small to hold the marker at all leaves the fence open rather than
    // producing a piece the transport refuses outright.
    const open: boolean = fenceCount(`${prefix}${head}`) % 2 === 1
      && prefix.length + head.length + FENCE_CLOSE.length <= maxChars
    if (head !== '') parts.push(`${prefix}${head}${open ? FENCE_CLOSE : ''}`)
    rest = rest.slice(cut).trimStart()
    reopen = open
  }
  return parts
}

/**
 * The cut to use, shrunk until the piece it produces fits the ceiling.
 *
 * A piece that ends inside a fence gets a closing marker appended, and that
 * marker was never part of the window the cut was chosen in. Shrinking the cut
 * moves the overflow into the next piece, where it still fits, instead of
 * letting the finished piece exceed the transport's limit.
 *
 * The parity is re-checked on every shrink: a shorter cut can fall *before* the
 * marker that made the piece open, in which case no marker is needed at all and
 * the piece fits immediately.
 * @param text - the text being cut.
 * @param prefix - the reopening fence this piece will carry, if any.
 * @param budget - the window to choose a cut in.
 * @param maxChars - the ceiling the finished piece must respect.
 * @returns a cut index in `(0, budget]`.
 */
function fitCut(text: string, prefix: string, budget: number, maxChars: number): number {
  let cut = findCut(text, budget)
  while (cut > 1) {
    const head = text.slice(0, cut).trimEnd()
    const open = fenceCount(`${prefix}${head}`) % 2 === 1
    const needed = prefix.length + head.length + (open ? FENCE_CLOSE.length : 0)
    if (needed <= maxChars) return cut
    // Strictly decreasing, so this terminates: the branch is only reached when
    // the piece is over by at least one character.
    cut = Math.max(1, cut - (needed - maxChars))
  }
  return cut
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

/** How many fence markers the text contains. */
function fenceCount(text: string): number {
  let count = 0
  for (const _match of text.matchAll(FENCE_LINE)) count += 1
  return count
}
