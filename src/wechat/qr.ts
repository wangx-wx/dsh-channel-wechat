/**
 * The login QR the panel displays.
 *
 * The iLink `qrcode_img_content` value is an HTML page that draws the code with
 * JavaScript, not an image, so `<img src>` shows nothing: the URL has to be
 * encoded here, from a vendored copy of `qrcode-generator`.
 *
 * @module dsh-channel-wechat/wechat/qr
 */

import qrcode from '../vendor/qrcode.mjs'

/** Pixels per QR module. */
export const CELL_SIZE = 4

/**
 * Quiet zone, in modules. The standard requires 4: scanners use the light area
 * around the code to find its edges, so a code drawn flush to its box scans
 * unreliably.
 */
export const QUIET_ZONE_MODULES = 4

/**
 * Replace the vendored build's byte encoder with a real UTF-8 one.
 *
 * The default build truncates each UTF-16 code unit to a single byte
 * (`charCode & 0xff`), which is only correct for Latin-1. Every other build of
 * this library ships a separate `qrcode_UTF8` file that overrides this same
 * function; doing it in place avoids importing a second copy of the encoder.
 * It matters because `addData` measures the payload with it, so a wrong encoder
 * can pick a version too small for the data.
 */
qrcode.stringToBytes = (text: string): number[] => [...new TextEncoder().encode(text)]

/**
 * Render a login URL as an SVG QR code.
 * @param url - the value to encode, as the iLink server supplied it.
 * @returns a self-contained SVG document.
 */
export function renderQrSvg(url: string): string {
  const code = qrcode(0, 'M')
  code.addData(url)
  code.make()
  return code.createSvgTag({
    cellSize: CELL_SIZE,
    margin: QUIET_ZONE_MODULES * CELL_SIZE,
    scalable: true,
    title: '微信登录二维码',
  })
}
