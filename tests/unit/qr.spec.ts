/**
 * The login QR the panel displays.
 *
 * A QR that cannot be scanned is indistinguishable from a broken channel: the
 * user scans, nothing happens, and there is no error anyone can read. So the
 * assertions here check the encoder against the QR standard rather than against
 * its own output - expected module counts are literal values from the standard's
 * byte-mode capacity table, computed by hand for the payloads below.
 *
 * The iLink `qrcode_img_content` value is an HTML page that draws the code with
 * JavaScript, not an image, so `<img src>` shows nothing and the URL has to be
 * encoded here.
 */

import { describe, expect, it } from 'vitest'
import { CELL_SIZE, QUIET_ZONE_MODULES, renderQrSvg } from '../../src/wechat/qr.ts'

/** The side length in pixels implied by a module count, margin included. */
function expectedSide(modules: number): number {
  return modules * CELL_SIZE + 2 * QUIET_ZONE_MODULES * CELL_SIZE
}

describe('rendering the login QR', () => {
  it('sizes the code for the payload rather than a fixed version', () => {
    // 21 bytes exceeds version 1's 14-byte capacity at level M, so the standard
    // requires version 2 - 25 modules per side. A fixed small version would
    // silently truncate or throw, and the user would see an unscannable code.
    const svg = renderQrSvg('https://weixin.test/a')

    expect(svg).toContain(`viewBox="0 0 ${String(expectedSide(25))} ${String(expectedSide(25))}"`)
  })

  it('picks the version a real login URL needs', () => {
    // 53 bytes fits version 4 (62-byte capacity) but not version 3 (42), so the
    // standard requires 33 modules per side.
    const url = 'https://ilinkai.weixin.qq.com/qrcode/abcdefghijklmnop'
    const svg = renderQrSvg(url)

    expect(svg).toContain(`viewBox="0 0 ${String(expectedSide(33))} ${String(expectedSide(33))}"`)
  })

  it('measures the payload in UTF-8 bytes, not UTF-16 units', () => {
    // The vendored build's own encoder truncates each UTF-16 code unit to one
    // byte, so it counts 中 as 1 byte where UTF-8 needs 3. This payload is 13
    // ASCII characters plus one 中: 14 code units, which the wrong encoder
    // would call version 1 (21 modules) when the standard requires version 2
    // (25 modules, since 16 bytes exceeds version 1's 14-byte capacity). The
    // QR would then be built from a truncated byte stream.
    const svg = renderQrSvg(`${'a'.repeat(13)}中`)

    expect(svg).toContain('viewBox="0 0 132 132"')
  })

  it('leaves the standard quiet zone around the code', () => {
    // The margin is part of the definition, not decoration: scanners use the
    // surrounding light area to find the code's edges, so a code drawn flush to
    // its box scans unreliably. The standard requires 4 modules.
    expect(QUIET_ZONE_MODULES).toBe(4)
    const svg = renderQrSvg('https://weixin.test/a')

    // 25 modules at 4px each, plus 4 modules of margin on both sides.
    expect(expectedSide(25)).toBe(25 * 4 + 2 * 4 * 4)
    expect(svg).toContain('viewBox="0 0 132 132"')
  })
})
