/**
 * Wire types for the WeChat iLink bot protocol.
 *
 * Field names, optionality, and numeric discriminants come from the protocol
 * document's type tables. Everything is optional on the wire except where the
 * document states otherwise, which is why the parsers downstream are written
 * defensively rather than trusting these shapes.
 *
 * @module dsh-channel-wechat/wechat/types
 */

/** Which side produced a message: `1` user, `2` bot. */
export const MessageType = { USER: 1, BOT: 2 } as const

/** Lifecycle of a message: `0` new, `1` generating, `2` finished. */
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const

/** Item discriminants inside {@link MessageItem}. */
export const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
} as const

/** A text body. */
export interface TextItem {
  /** The text itself. */
  text?: string
}

/** A voice body; `text` carries the server-side transcription when present. */
export interface VoiceItem {
  /** Transcription of the audio, when the server produced one. */
  text?: string
  /** Encoding identifier; not every value is decodable by this client. */
  encode_type?: number
  /** Sample rate in Hz. */
  sample_rate?: number
  /** Duration in milliseconds. */
  playtime?: number
}

/** CDN reference for an encrypted media object. */
export interface MediaRef {
  /** Download parameter. */
  encrypt_query_param?: string
  /** Base64-encoded AES key. */
  aes_key?: string
  /** A complete URL, preferred over constructing one from the CDN base. */
  full_url?: string
}

/** An image body. */
export interface ImageItem {
  /** Inbound AES key as 32 hex characters; takes precedence over `media.aes_key`. */
  aeskey?: string
  /** Ciphertext length the sender reports. */
  mid_size?: number
  /** The encrypted object. */
  media?: MediaRef
  /** Thumbnail, when present. */
  thumb_media?: MediaRef
}

/** A file body. */
export interface FileItem {
  /** Attachment name. */
  file_name?: string
  /** Plaintext length as a decimal string. */
  len?: string
  /** The encrypted object. */
  media?: MediaRef
}

/** A video body. */
export interface VideoItem {
  /** Ciphertext length the sender reports. */
  video_size?: number
  /** The encrypted object. */
  media?: MediaRef
  /** Thumbnail, when present. */
  thumb_media?: MediaRef
}

/** One element of a message body. */
export interface MessageItem {
  /** Discriminant; see {@link MessageItemType}. */
  type?: number
  /** Present when `type` is 1. */
  text_item?: TextItem
  /** Present when `type` is 2. */
  image_item?: ImageItem
  /** Present when `type` is 3. */
  voice_item?: VoiceItem
  /** Present when `type` is 4. */
  file_item?: FileItem
  /** Present when `type` is 5. */
  video_item?: VideoItem
  /** Client-supplied or associated identifier. */
  msg_id?: string
  /** Whether the producer considers this element complete. */
  is_completed?: boolean
  /** The message this element quotes, when it is a reply. */
  ref_msg?: { message_item?: MessageItem }
}

/** One message returned by `getUpdates`. */
export interface WeixinMessage {
  /** Server sequence number. */
  seq?: number
  /** Server message id. */
  message_id?: number
  /** Sender. */
  from_user_id?: string
  /** Recipient. */
  to_user_id?: string
  /** Client-supplied or associated id. */
  client_id?: string
  /** Creation time in milliseconds. */
  create_time_ms?: number
  /** Last update time in milliseconds. */
  update_time_ms?: number
  /** Deletion time in milliseconds. */
  delete_time_ms?: number
  /** Conversation id. */
  session_id?: string
  /** Group id; present in the types but not a supported capability. */
  group_id?: string
  /** See {@link MessageType}. */
  message_type?: number
  /** See {@link MessageState}. */
  message_state?: number
  /** Message body. */
  item_list?: MessageItem[]
  /** The token a reply must echo. */
  context_token?: string
  /** Generation or run id, when applicable. */
  run_id?: string
}

/** The `getUpdates` response body. */
export interface GetUpdatesResponse {
  /** `0` on success. */
  ret?: number
  /** Application error code. */
  errcode?: number
  /** Error description. */
  errmsg?: string
  /** Messages received since the previous cursor. */
  msgs?: WeixinMessage[]
  /** Cursor to send on the next request. */
  get_updates_buf?: string
  /** Server-suggested long-poll timeout in milliseconds. */
  longpolling_timeout_ms?: number
}
