/**
 * Turning downloaded media into message content.
 *
 * WeChat sends images, files, voice, and video; a model accepts text, images,
 * and (as projected handle text) files. Bridging that gap is this module's job,
 * and the rule that shapes it is:
 *
 * **A message must still be delivered when its media cannot be.** Media is an
 * addition to what the user said, never a precondition for being heard. So every
 * failure - a CDN error, bytes the store refuses, a model that cannot see images
 * - becomes a note appended to the message rather than a dropped turn. The
 * alternative loses the user's words because of an unrelated transport failure.
 *
 * Everything is injected rather than reached for, so the decisions above are
 * testable without a cordis context, an attachment store, or a network.
 *
 * @module dsh-channel-wechat/bridge/media
 */

import type { FileAttachmentRef, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { InboundMedia } from '../wechat/inbound.ts'

/** A content block this module can produce: an admitted image or file. */
export type MediaPart =
  | { type: 'image'; attachment: ImageAttachmentRef }
  | { type: 'file'; attachment: FileAttachmentRef }

/** What one message's media became. */
export interface PreparedMedia {
  /** Content blocks to append after the text, in item order. */
  parts: MediaPart[]
  /** Human-readable notes for media that could not be attached. */
  notes: string[]
}

/** Collaborators for {@link prepareMedia}. */
export interface PrepareMediaOptions {
  /** Fetch and decrypt one object. */
  download: (media: InboundMedia) => Promise<Uint8Array>
  /** Commit one image and return its durable reference. */
  admitImage: (input: { data: Uint8Array; mediaType: ImageMediaType; name?: string }) => Promise<ImageAttachmentRef>
  /** Commit one file and return its durable reference. */
  admitFile: (input: { data: Uint8Array; name?: string }) => Promise<FileAttachmentRef>
  /** Whether the session's model accepts image input. May need a lookup. */
  supportsImage: () => boolean | Promise<boolean>
  /** Observe a failure that became a note instead of an error. */
  report?: (label: string, detail: unknown) => void
}

/**
 * Download and admit every object a message carried.
 *
 * Never throws: a failure is reported and turned into a note, because the text
 * the user actually typed must still reach the model.
 * @param media - the descriptors parsed from the message, in item order.
 * @param options - the download, the store, and the route's image capability.
 * @returns the content blocks and the notes for whatever could not be attached.
 */
export async function prepareMedia(
  media: readonly InboundMedia[],
  options: PrepareMediaOptions,
): Promise<PreparedMedia> {
  const parts: MediaPart[] = []
  const notes: string[] = []
  for (const item of media) {
    try {
      const attached = await prepareOne(item, options)
      if (attached === undefined) continue
      if (typeof attached === 'string') notes.push(attached)
      else parts.push(attached)
    } catch (error) {
      // Reported and noted rather than rethrown: the message is still delivered.
      options.report?.(`media ${item.kind}`, error)
      notes.push(noteFor(item, error))
    }
  }
  return { parts, notes }
}

/**
 * Prepare one object.
 * @returns a content block, a note, or `undefined` when the kind is not
 *   attachable at all and the label already says so.
 */
async function prepareOne(
  item: InboundMedia,
  options: PrepareMediaOptions,
): Promise<MediaPart | string | undefined> {
  // Voice arrives with the server's transcription as the message text, and no
  // provider takes audio, so downloading it would add nothing the model can use.
  if (item.kind === 'voice') return '（这条消息是一段语音，已附转写文字。）'
  // Video is not a model input format; the honest thing is to say one was sent.
  if (item.kind === 'video') return '（这条消息包含一段视频，当前无法读取。）'

  const data = await options.download(item)
  if (item.kind === 'file') {
    const attachment = await options.admitFile({ data, ...(item.name === undefined ? {} : { name: item.name }) })
    return { type: 'file', attachment }
  }

  const mediaType = sniffImageType(data)
  if (mediaType === undefined) {
    // The store validates declared types against the bytes and rejects a
    // mismatch, so sniffing here is what turns "unsupported blob" into a note
    // instead of a thrown admission error that would lose the message.
    throw new Error('unsupported image format')
  }
  if (!(await options.supportsImage())) {
    return '（收到一张图片，但当前模型不支持图片输入，未能读取。）'
  }
  const attachment = await options.admitImage({ data, mediaType })
  return { type: 'image', attachment }
}

/** The note for one object that could not be attached. */
function noteFor(item: InboundMedia, error: unknown): string {
  const what = item.kind === 'image' ? '图片' : item.kind === 'file' ? '文件' : '媒体'
  return `（这条消息里的${what}未能读取：${error instanceof Error ? error.message : String(error)}）`
}

/**
 * Name an image's format from its leading bytes.
 *
 * The wire carries no media type, and the attachment store verifies a declared
 * type against the bytes. Sniffing is therefore the only way to declare one that
 * will be accepted.
 * @param data - the downloaded bytes.
 * @returns a media type the store accepts, or `undefined` when it is not an
 *   image this deployment takes.
 */
export function sniffImageType(data: Uint8Array): ImageMediaType | undefined {
  if (data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 12
    && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif'
  return undefined
}
