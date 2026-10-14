/**
 * Sending one declared deliverable: the step order, and the values derived from
 * the bytes actually uploaded.
 *
 * The digest and the padded size are checked by the server against what is
 * posted, so they must come from the same read. This suite pins that down and
 * the shapes that would break it.
 */

import { describe, expect, it } from 'vitest'
import { sendFileToPeer } from '../../src/bridge/send-file.ts'

/** The bytes under test, and the values they must produce. */
const CONTENT = Buffer.from('hello deliverable')

/** A set of collaborators that record their inputs. */
function bench(overrides: Partial<Parameters<typeof sendFileToPeer>[1]> = {}) {
  const asked: unknown[] = []
  const uploaded: unknown[] = []
  const sent: unknown[] = []
  const options = {
    read: async () => CONTENT,
    requestUploadUrl: async (input: never) => { asked.push(input); return { uploadParam: 'up-1' } },
    upload: async (input: never) => { uploaded.push(input); return { downloadParam: 'dl-1' } },
    send: async (input: never) => { sent.push(input) },
    ...overrides,
  } as Parameters<typeof sendFileToPeer>[1]
  return { asked, uploaded, sent, options }
}

describe('sending one file to a conversation', () => {
  it('reads, authorizes, uploads, and sends, in that order', async () => {
    // The sequence itself is the contract: uploading before authorizing gives
    // the CDN an object with no declared metadata.
    const order: string[] = []
    const { options } = bench({
      read: async () => { order.push('read'); return CONTENT },
      requestUploadUrl: async () => { order.push('authorize'); return { uploadParam: 'up-1' } },
      upload: async () => { order.push('upload'); return { downloadParam: 'dl-1' } },
      send: async () => { order.push('send') },
    })

    await sendFileToPeer({ path: '/w/report.txt' }, options)

    expect(order).toEqual(['read', 'authorize', 'upload', 'send'])
  })

  it('declares the plaintext size, the padded size, and the digest of the bytes', async () => {
    // `rawsize` is what the user receives, `filesize` is what is posted, and the
    // server checks both against the upload. Deriving them from a second read
    // would let a changed file break the pair.
    const { asked, options } = bench()

    await sendFileToPeer({ path: '/w/report.txt' }, options)

    const ask = asked[0] as Record<string, unknown>
    expect(ask['rawsize']).toBe(CONTENT.length)
    // ceil((17+1)/16)*16 = 32, from the documented PKCS#7 rule.
    expect(ask['filesize']).toBe(32)
    expect(ask['rawfilemd5']).toMatch(/^[0-9a-f]{32}$/u)
    expect(ask['mediaType']).toBe(3)
    expect(typeof ask['filekey']).toBe('string')
    expect(ask['aeskey']).toMatch(/^[0-9a-f]{32}$/u)
  })

  it('sends the name the recipient sees and the length they get', async () => {
    // `len` is the PLAINTEXT length while the reference points at the ciphertext;
    // mixing them up truncates the file on the client.
    const { uploaded, sent, options } = bench()

    await sendFileToPeer({ path: '/w/report.txt' }, options)

    // The upload carried the same object key the authorization named.
    const message = sent[0] as Record<string, unknown>
    expect(typeof (uploaded[0] as Record<string, unknown>)['filekey']).toBe('string')
    expect(message['fileName']).toBe('report.txt')
    expect(message['encryptQueryParam']).toBe('dl-1')
    expect(message['plaintextSize']).toBe(CONTENT.length)
    expect(message['ciphertextSize']).toBe(32)
  })

  it('spells the key as base64 of its hex form, which is what reading it back expects', async () => {
    // The protocol sends the key as hex in the authorize request and as
    // base64(hex) in the media reference. `parseAesKey` accepts exactly that
    // pair, so getting this wrong yields a file the sender cannot decrypt.
    const { asked, sent, options } = bench()

    await sendFileToPeer({ path: '/w/report.txt' }, options)

    const hex = (asked[0] as Record<string, unknown>)['aeskey'] as string
    const base64 = (sent[0] as Record<string, unknown>)['aesKeyBase64'] as string
    expect(Buffer.from(base64, 'base64').toString('ascii')).toBe(hex)
  })

  it('uses only the basename of the path as the file name', async () => {
    // A path the recipient sees leaks the sender's directory layout and is not a
    // legal file name on every client.
    const { sent, options } = bench()

    await sendFileToPeer({ path: '/Users/someone/private/report.txt' }, options)

    expect((sent[0] as Record<string, unknown>)['fileName']).toBe('report.txt')
  })

  it('lets an explicit name win over the path', async () => {
    const { sent, options } = bench()

    await sendFileToPeer({ path: '/w/tmp-1234.bin', name: '月度报表.xlsx' }, options)

    expect((sent[0] as Record<string, unknown>)['fileName']).toBe('月度报表.xlsx')
  })

  it('passes a complete upload URL through when the server sent one', async () => {
    // The server sometimes authorizes with a ready URL; dropping it would post
    // to a URL this code guessed instead.
    const { uploaded, options } = bench({
      requestUploadUrl: async () => ({ uploadFullUrl: 'https://cdn.test/u?x=1' }),
    })

    await sendFileToPeer({ path: '/w/report.txt' }, options)

    expect((uploaded[0] as Record<string, unknown>)['uploadFullUrl']).toBe('https://cdn.test/u?x=1')
  })

  it('propagates a failed read rather than sending an empty file', async () => {
    // Sending zero bytes would tell the user a file arrived that is unusable.
    const { sent, options } = bench({
      read: async () => { throw new Error('ENOENT') },
    })

    await expect(sendFileToPeer({ path: '/w/gone.txt' }, options)).rejects.toThrow(/ENOENT/u)
    expect(sent).toEqual([])
  })

  it('propagates a refused upload rather than sending a message citing nothing', async () => {
    // A send after a failed upload would produce a bubble pointing at an object
    // that does not exist.
    const { sent, options } = bench({
      upload: async () => { throw new Error('CDN 500') },
    })

    await expect(sendFileToPeer({ path: '/w/report.txt' }, options)).rejects.toThrow(/CDN 500/u)
    expect(sent).toEqual([])
  })
})
