/**
 * Splitting one long answer into messages the transport will accept.
 *
 * The transport sends one text item per call and refuses a body past its limit,
 * and WeChat has no replay - so an unsplit over-long answer is lost entirely. The
 * cut also has to be readable: a split inside a sentence reads as a typo, and a
 * split inside a code fence renders as broken text on both sides.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_CHARS, splitMessage } from '../../src/bridge/split.ts'

describe('splitting a reply', () => {
  it('leaves a short reply alone', () => {
    // The ordinary case must not be reflowed.
    expect(splitMessage('hello', 100)).toEqual(['hello'])
  })

  it('returns nothing for text that is only whitespace', () => {
    expect(splitMessage('   \n\n  ', 10)).toEqual([])
  })

  it('splits at a paragraph boundary when one is available', () => {
    // A split inside a sentence reads as a typo.
    const text = `${'a'.repeat(40)}\n\n${'b'.repeat(40)}`
    expect(splitMessage(text, 50)).toEqual(['a'.repeat(40), 'b'.repeat(40)])
  })

  it('prefers a paragraph break over a line break', () => {
    const text = `${'a'.repeat(20)}\n${'b'.repeat(20)}\n\n${'c'.repeat(20)}`
    const parts = splitMessage(text, 45)
    // The paragraph boundary is the later, more readable cut.
    expect(parts[0]).toBe(`${'a'.repeat(20)}\n${'b'.repeat(20)}`)
    expect(parts[1]).toBe('c'.repeat(20))
  })

  it('falls back to a sentence break when there is no paragraph', () => {
    const text = `${'a'.repeat(30)}。${'b'.repeat(30)}`
    expect(splitMessage(text, 40)).toEqual([`${'a'.repeat(30)}。`, 'b'.repeat(30)])
  })

  it('cuts at the limit when no break exists', () => {
    const parts = splitMessage('x'.repeat(25), 10)
    expect(parts.join('')).toBe('x'.repeat(25))
    expect(parts.every(part => part.length <= 10)).toBe(true)
  })

  it('never returns a piece longer than the limit', () => {
    // The whole point: a piece past the ceiling is a refused message.
    const text = Array.from({ length: 200 }, (_, i) => `line ${String(i)} with some text`).join('\n')
    for (const max of [50, 200, 500, 2_000]) {
      const parts = splitMessage(text, max)
      expect(parts.every(part => part.length <= max)).toBe(true)
    }
  })

  it('loses no text', () => {
    const text = '第一段。\n\n第二段内容比较长。\n\n第三段。'
    expect(splitMessage(text, 12).join('')).toBe(text.replace(/\s+/gu, ''))
  })

  it('does not leave a code fence open', () => {
    // A fence closed in one message and reopened in the next renders as broken
    // text on both sides of the cut.
    const text = `before\n\n\`\`\`\n${'code line\n'.repeat(30)}\`\`\`\n\nafter`
    for (const part of splitMessage(text, 100)) {
      const fences = part.split('\n').filter(line => line.trimStart().startsWith('```')).length
      expect(fences % 2).toBe(0)
    }
  })

  it('keeps every piece non-empty', () => {
    const parts = splitMessage(`a${'\n'.repeat(500)}b`, 50)
    expect(parts.every(part => part.trim() !== '')).toBe(true)
  })

  it('uses a ceiling below both reference implementations', () => {
    // The protocol document states no limit and the reference implementations
    // disagree (4000 and 2000); staying under both is the conservative reading.
    expect(DEFAULT_MAX_CHARS).toBeLessThanOrEqual(2_000)
  })
})
