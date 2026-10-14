/**
 * Sending one declared deliverable to a WeChat conversation.
 *
 * Three steps, and the order matters: read the file, authorize and upload its
 * ciphertext, then send a message citing the returned download parameter. The
 * `getuploadurl` metadata has to be computed from the SAME bytes that are
 * uploaded - the server checks the declared digest and padded size against what
 * actually arrives, so computing them from a stale read produces a refused
 * upload rather than a corrupt file.
 *
 * Everything external is injected, so the sequence and its failure rules are
 * testable without a disk, a network, or a CDN.
 *
 * @module dsh-channel-wechat/bridge/send-file
 */

import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { aesEcbPaddedSize } from '../wechat/crypto.ts'
import { UploadMediaType } from '../wechat/api.ts'

/** One file to send. */
export interface OutboundFile {
  /** An absolute path to a regular file. */
  path: string
  /** A display name; defaults to the file's own basename. */
  name?: string
}

/** Collaborators for {@link sendFileToPeer}. */
export interface SendFileOptions {
  /** Read the file's bytes. */
  read: (path: string) => Promise<Uint8Array>
  /** Authorize an upload and report where it may go. */
  requestUploadUrl: (input: {
    filekey: string
    mediaType: number
    rawsize: number
    rawfilemd5: string
    filesize: number
    aeskey: string
  }) => Promise<{ uploadFullUrl?: string | undefined; uploadParam?: string | undefined }>
  /** Upload the ciphertext and return the download parameter. */
  upload: (input: {
    filekey: string
    data: Uint8Array
    key: Uint8Array
    uploadFullUrl?: string | undefined
    uploadParam?: string | undefined
  }) => Promise<{ downloadParam: string }>
  /** Send the message that cites the uploaded object. */
  send: (input: {
    fileName: string
    encryptQueryParam: string
    aesKeyBase64: string
    ciphertextSize: number
    plaintextSize: number
  }) => Promise<void>
}

/**
 * Read, upload, and send one file.
 *
 * @param file - the file to send.
 * @param options - the injected disk, upload, and send steps.
 * @throws when the file cannot be read or the upload is refused, so the caller
 *   can report it rather than telling the user a file arrived that did not.
 */
export async function sendFileToPeer(file: OutboundFile, options: SendFileOptions): Promise<void> {
  // Read ONCE, and derive every declared value from these exact bytes: the
  // server verifies the digest and the padded size against what is posted.
  const data = await options.read(file.path)
  const rawfilemd5 = createHash('md5').update(data).digest('hex')
  const filekey = randomBytes(16).toString('hex')
  const key = randomBytes(16)

  const target = await options.requestUploadUrl({
    filekey,
    mediaType: UploadMediaType.FILE,
    rawsize: data.byteLength,
    rawfilemd5,
    filesize: aesEcbPaddedSize(data.byteLength),
    // Hex, which is how the protocol spells the key in this request.
    aeskey: key.toString('hex'),
  })

  const { downloadParam } = await options.upload({
    filekey,
    data,
    key,
    uploadFullUrl: target.uploadFullUrl,
    uploadParam: target.uploadParam,
  })

  await options.send({
    // The basename keeps a local directory structure out of the name the
    // recipient sees.
    fileName: file.name ?? basename(file.path),
    encryptQueryParam: downloadParam,
    // Base64 of the HEX spelling - the form the media reference uses, and the
    // one `parseAesKey` expects when reading it back.
    aesKeyBase64: Buffer.from(key.toString('hex'), 'utf8').toString('base64'),
    ciphertextSize: aesEcbPaddedSize(data.byteLength),
    plaintextSize: data.byteLength,
  })
}

/** The default reader, so production does not have to supply one. */
export async function readFileBytes(path: string): Promise<Uint8Array> {
  return await readFile(path)
}
