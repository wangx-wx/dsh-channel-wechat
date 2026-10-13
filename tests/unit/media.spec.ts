/**
 * Turning downloaded media into message content.
 *
 * The pieces are injected rather than reached for, so the decisions worth
 * testing - what happens when the model cannot see images, when a download
 * fails, when the bytes are not a format the store accepts - are testable
 * without a cordis context, an attachment store, or a network.
 *
 * The rule that shapes everything here: **a message must still be delivered when
 * its media cannot be.** Media is an addition to what the user said, never a
 * precondition for being heard, so every failure becomes a note in the message
 * rather than a dropped turn.
 */

import { describe, expect, it, vi } from 'vitest'
import { prepareMedia } from '../../src/bridge/media.ts'
import type { InboundMedia } from '../../src/wechat/inbound.ts'

/** A PNG header, which is all the sniffer needs to recognize the format. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])

/** A JPEG header. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])

/** A store that records what it was asked to admit. */
function fakeStore() {
  const images: { data: Uint8Array; mediaType: string; name?: string }[] = []
  const files: { data: Uint8Array; name?: string }[] = []
  return {
    images,
    files,
    admitImage: async (input: { data: Uint8Array; mediaType: never; name?: string }) => {
      images.push(input)
      return { attachmentId: `img-${String(images.length)}`, mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 }
    },
    admitFile: async (input: { data: Uint8Array; name?: string }) => {
      files.push(input)
      return { attachmentId: `file-${String(files.length)}`, name: input.name ?? 'file.bin', bytes: input.data.length }
    },
  }
}

/** Options with sensible defaults, so each test states only what it is about. */
function options(overrides: Partial<Parameters<typeof prepareMedia>[1]> = {}) {
  const store = fakeStore()
  return {
    store,
    options: {
      download: async () => PNG,
      admitImage: store.admitImage,
      admitFile: store.admitFile,
      supportsImage: () => true,
      ...overrides,
    } as Parameters<typeof prepareMedia>[1],
  }
}

const IMAGE: InboundMedia = { kind: 'image', encryptQueryParam: 'p1', aesKeyBase64: 'AAECAwQFBgcICQoLDA0ODw==' }

describe('preparing media for delivery', () => {
  it('admits an image and returns it as an image content block', () => {
    // The path that makes "发图能理解" true: bytes in, a block the model sees.
    const { store, options: opts } = options()

    return prepareMedia([IMAGE], opts).then((prepared) => {
      expect(prepared.parts).toEqual([{
        type: 'image',
        attachment: { attachmentId: 'img-1', mediaType: 'image/png', bytes: PNG.length, width: 1, height: 1 },
      }])
      expect(prepared.notes).toEqual([])
      expect(store.images).toHaveLength(1)
    })
  })

  it('names the format from the bytes rather than trusting a label', () => {
    // The wire gives no media type, and the store rejects a declared type that
    // disagrees with the bytes. Sniffing is what keeps a JPEG from being
    // admitted as PNG and refused.
    const { store, options: opts } = options({ download: async () => JPEG })

    return prepareMedia([IMAGE], opts).then(() => {
      expect(store.images[0]?.mediaType).toBe('image/jpeg')
    })
  })

  it('passes the sender\u2019s filename through for a file', () => {
    // `fileHostPath` and the projected handle text both show this name, so
    // losing it leaves the model with an unnamed blob.
    const { store, options: opts } = options()

    return prepareMedia(
      [{ kind: 'file', encryptQueryParam: 'p2', name: 'report.pdf' }],
      opts,
    ).then((prepared) => {
      expect(prepared.parts).toEqual([
        { type: 'file', attachment: { attachmentId: 'file-1', name: 'report.pdf', bytes: PNG.length } },
      ])
      expect(store.files[0]?.name).toBe('report.pdf')
    })
  })

  it('describes an image instead, when the model cannot see images', () => {
    // Saving an image the model will never receive wastes storage and leaves the
    // user believing it was understood. The note says plainly that it was not.
    const { store, options: opts } = options({ supportsImage: () => false })

    return prepareMedia([IMAGE], opts).then((prepared) => {
      expect(prepared.parts).toEqual([])
      expect(prepared.notes.join('\n')).toMatch(/图片/u)
      expect(store.images).toEqual([])
    })
  })

  it('delivers a note instead of dropping the message when a download fails', () => {
    // Media is an addition to what the user said, never a precondition for
    // being heard: a CDN failure must not swallow the turn.
    const report = vi.fn()
    const { options: opts } = options({
      download: async () => { throw new Error('CDN 500') },
      report,
    })

    return prepareMedia([IMAGE], opts).then((prepared) => {
      expect(prepared.parts).toEqual([])
      expect(prepared.notes.join('\n')).toMatch(/图片/u)
      // Reported once, so an operator can see why, without the user's message
      // being lost.
      expect(report).toHaveBeenCalledTimes(1)
    })
  })

  it('notes bytes the store cannot accept rather than admitting them', () => {
    // A GIF is accepted by the store; a random blob is not. Admitting it would
    // throw from the store and lose the message, so it is checked here first.
    const { store, options: opts } = options({ download: async () => Buffer.from('not an image at all') })

    return prepareMedia([IMAGE], opts).then((prepared) => {
      expect(prepared.parts).toEqual([])
      expect(prepared.notes.join('\n')).toMatch(/图片/u)
      expect(store.images).toEqual([])
    })
  })

  it('keeps going after one failure, so other media still arrives', () => {
    // A message can carry several items; one bad object must not take the good
    // ones with it.
    let calls = 0
    const { store, options: opts } = options({
      download: async () => {
        calls += 1
        if (calls === 1) throw new Error('first one fails')
        return PNG
      },
    })

    return prepareMedia([IMAGE, IMAGE], opts).then((prepared) => {
      expect(prepared.parts).toHaveLength(1)
      expect(prepared.notes).toHaveLength(1)
      expect(store.images).toHaveLength(1)
    })
  })

  it('describes voice and video, which no provider accepts natively', () => {
    // Neither is a model input format, and voice already arrives as its
    // transcription, so the honest thing is to say what was sent.
    const { options: opts } = options()

    return prepareMedia(
      [{ kind: 'voice', encryptQueryParam: 'p3' }, { kind: 'video', encryptQueryParam: 'p4' }],
      opts,
    ).then((prepared) => {
      expect(prepared.parts).toEqual([])
      expect(prepared.notes.join('\n')).toMatch(/语音/u)
      expect(prepared.notes.join('\n')).toMatch(/视频/u)
    })
  })

  it('does nothing at all when there is no media', () => {
    // The common case must not pay for a download or a store lookup.
    const download = vi.fn()
    const { options: opts } = options({ download })

    return prepareMedia([], opts).then((prepared) => {
      expect(prepared).toEqual({ parts: [], notes: [] })
      expect(download).not.toHaveBeenCalled()
    })
  })
})
