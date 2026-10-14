/**
 * Reading one inbound message.
 *
 * Pure and defensive: the wire types mark almost every field optional, so each
 * read decides what an absent value means. Two decisions are worth stating
 * because the opposite is plausible:
 *
 *  - The bot's own echo and in-progress placeholders are dropped. Every reply
 *    returns through `getUpdates`, and a channel that treats its own output as
 *    input answers itself.
 *  - A message with no `context_token` is still delivered. The protocol's
 *    client logs a warning and continues; dropping the message would instead
 *    lose something the user typed.
 *
 * @module dsh-channel-wechat/wechat/inbound
 */

import { MessageItemType, MessageState, MessageType, type MessageItem, type WeixinMessage } from './types.ts'

export type { MessageItem, WeixinMessage } from './types.ts'

/** Which media an item carries. */
export type MediaKind = 'image' | 'voice' | 'file' | 'video'

/**
 * One downloadable media object, named but not fetched.
 *
 * Parsing stops at the descriptor: this module is pure and reaches no network,
 * so the bytes are the download path's job. `aesKeyBase64` is the *normalized*
 * key, already in the one encoding {@link parseAesKey} accepts, because the wire
 * spells it two different ways depending on the media type.
 */
export interface InboundMedia {
  /** Which item produced this. */
  kind: MediaKind
  /** The download parameter, or `''` when only a `full_url` was sent. */
  encryptQueryParam: string
  /** The key, in the single encoding the download path accepts. */
  aesKeyBase64?: string
  /** A complete URL the sender provided, preferred over building one. */
  fullUrl?: string
  /** The sender's filename, for a file. */
  name?: string
  /** The plaintext byte count the sender reports, for a file. */
  size?: number
}

/** A message worth handing to the agent. */
export interface InboundMessage {
  /** The other party; also the session-mapping key. */
  peerId: string
  /** Text to deliver, or a short label when the message carried only media. */
  text: string
  /** The token a reply must echo, when the server issued one. */
  contextToken: string | undefined
  /** Correlates the reply with this message. */
  messageId: number | undefined
  /** Media to fetch before delivering, in item order; absent when there is none. */
  media?: readonly InboundMedia[]
  /**
   * The text of the message this one quotes, when it quotes one.
   *
   * DSH messages have no quote field, so this travels as part of the text the
   * model reads - without it a reply like "这个呢?" arrives with no referent.
   */
  quote?: string
}

/**
 * Read one wire message.
 * @param message - the message as `getUpdates` returned it.
 * @returns the parsed message, or `undefined` when it is not user input.
 */
export function parseInboundMessage(message: WeixinMessage): InboundMessage | undefined {
  // `message_type` absent is treated as a user message: the protocol documents
  // 1 as user, and a message with no sender is rejected just below anyway.
  if (message.message_type === MessageType.BOT) return undefined
  if (message.message_state === MessageState.GENERATING) return undefined

  const peerId = message.from_user_id?.trim() ?? ''
  if (peerId === '') return undefined

  const media = mediaFromItems(message.item_list)
  const quote = quoteFromItems(message.item_list)
  return {
    peerId,
    text: bodyFromItems(message.item_list),
    contextToken: message.context_token,
    messageId: message.message_id ?? message.seq,
    // Absent rather than empty, so the common text-only message has one obvious
    // thing to check before any download work starts.
    ...(media.length === 0 ? {} : { media }),
    ...(quote === undefined ? {} : { quote }),
  }
}

/**
 * Read the quoted text out of a message's items.
 *
 * The reference is a property of the ITEM that replies, and its content is
 * inline - so no lookup is needed and no server id is involved. This is why the
 * quote path is independent of the message-id representation.
 *
 * A reference carrying only `svr_id` (a newer client's shape) names content this
 * client never stored, so it yields no quote rather than an invented one.
 * @param items - the message's items, in order.
 * @returns the quoted text, or `undefined` when the message quotes nothing.
 */
export function quoteFromItems(items: MessageItem[] | undefined): string | undefined {
  for (const item of items ?? []) {
    const ref = item.ref_msg
    if (ref === undefined) continue
    const parts: string[] = []
    // The title is the server's summary and the body is the content; the
    // protocol's own reader keeps both, joined, because either can be the only
    // one present.
    if (ref.title !== undefined && ref.title.trim() !== '') parts.push(ref.title.trim())
    if (ref.message_item !== undefined) {
      // Read with the ordinary body reader, so a quoted image or file
      // contributes its label rather than nothing.
      const body = bodyFromItems([ref.message_item]).trim()
      if (body !== '') parts.push(body)
    }
    if (parts.length > 0) return parts.join(' | ')
  }
  return undefined
}

/**
 * Read every downloadable object out of a message's items.
 *
 * An item that names no object is skipped: the label in {@link bodyFromItems}
 * still stands, but there is nothing to fetch.
 * @param items - the message's items, in order.
 * @returns one descriptor per downloadable object, in item order.
 */
export function mediaFromItems(items: MessageItem[] | undefined): InboundMedia[] {
  const found: InboundMedia[] = []
  for (const item of items ?? []) {
    const media = mediaFromItem(item)
    if (media !== undefined) found.push(media)
  }
  return found
}

/** Read one item's media, or `undefined` when it names no object. */
function mediaFromItem(item: MessageItem): InboundMedia | undefined {
  if (item.type === MessageItemType.IMAGE) {
    const image = item.image_item
    const ref = image?.media
    if (ref === undefined) return undefined
    // The item-level `aeskey` is the raw key as hex while `media.aes_key` is
    // base64, and the item-level one wins. Converting here means the download
    // path sees a single encoding: handing `parseAesKey` bare hex would make it
    // read the ASCII characters as key bytes and decrypt to garbage.
    const key = image?.aeskey === undefined
      ? ref.aes_key
      : Buffer.from(image.aeskey, 'hex').toString('base64')
    return { kind: 'image', ...commonRef(ref, key) }
  }
  if (item.type === MessageItemType.VOICE) {
    const ref = item.voice_item?.media
    if (ref === undefined) return undefined
    return { kind: 'voice', ...commonRef(ref, ref.aes_key) }
  }
  if (item.type === MessageItemType.FILE) {
    const file = item.file_item
    const ref = file?.media
    if (ref === undefined) return undefined
    return {
      kind: 'file',
      ...commonRef(ref, ref.aes_key),
      ...(file?.file_name === undefined ? {} : { name: file.file_name }),
      // A decimal string on the wire, because the protocol avoids floats for
      // byte counts. A value that is not a number is dropped rather than
      // becoming NaN.
      ...(file?.len === undefined || !/^\d+$/u.test(file.len) ? {} : { size: Number(file.len) }),
    }
  }
  if (item.type === MessageItemType.VIDEO) {
    const ref = item.video_item?.media
    if (ref === undefined) return undefined
    return { kind: 'video', ...commonRef(ref, ref.aes_key) }
  }
  return undefined
}

/**
 * The fields every media kind shares.
 *
 * Split out so the four kinds cannot disagree about how a reference is read - a
 * `full_url` missed for one kind is a download that fails for no visible reason.
 * @param ref - the CDN reference from the wire.
 * @param aesKeyBase64 - the already-normalized key, when the item carried one.
 * @returns the descriptor fields common to all kinds.
 */
function commonRef(
  ref: { encrypt_query_param?: string; full_url?: string },
  aesKeyBase64: string | undefined,
): Omit<InboundMedia, 'kind'> {
  return {
    encryptQueryParam: ref.encrypt_query_param ?? '',
    ...(aesKeyBase64 === undefined ? {} : { aesKeyBase64 }),
    // Only a non-empty URL is usable; an empty string would be preferred over
    // building one and then fail.
    ...(ref.full_url === undefined || ref.full_url === '' ? {} : { fullUrl: ref.full_url }),
  }
}

/**
 * Render a message body as text.
 *
 * The protocol puts a voice transcription in the voice item's own `text`, so
 * reading only `text_item` would drop voice messages. A body with neither text
 * nor a known media item still yields a label, because an empty string would
 * reach the agent as a blank message nobody sent.
 * @param items - the message's items, in order.
 * @returns the text to deliver.
 */
export function bodyFromItems(items: MessageItem[] | undefined): string {
  if (items === undefined || items.length === 0) return '(空消息)'
  for (const item of items) {
    // Text wins over any media in the same message, matching the protocol's
    // documented precedence.
    if (item.type === MessageItemType.TEXT) {
      const text = item.text_item?.text
      if (typeof text === 'string' && text !== '') return text
    }
    if (item.type === MessageItemType.VOICE) {
      const text = item.voice_item?.text
      if (typeof text === 'string' && text !== '') return text
    }
  }
  for (const item of items) {
    const label = mediaLabel(item)
    if (label !== undefined) return label
  }
  return '(空消息)'
}

/** A short description of a media item, for a message that carries no text. */
function mediaLabel(item: MessageItem): string | undefined {
  switch (item.type) {
    case MessageItemType.IMAGE:
      return '[图片]'
    case MessageItemType.VOICE:
      return '[语音]'
    case MessageItemType.FILE:
      return item.file_item?.file_name === undefined ? '[文件]' : `[文件] ${item.file_item.file_name}`
    case MessageItemType.VIDEO:
      return '[视频]'
    default:
      return undefined
  }
}
