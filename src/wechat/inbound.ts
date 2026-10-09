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

  return {
    peerId,
    text: bodyFromItems(message.item_list),
    contextToken: message.context_token,
    messageId: message.message_id ?? message.seq,
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
