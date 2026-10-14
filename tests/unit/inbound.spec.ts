/**
 * Turning one `getUpdates` message into something the agent can be given.
 *
 * Pure: the fields are read from the protocol document's `WeixinMessage` and
 * `MessageItem` tables, and nothing here reaches a network or a context. The
 * cases that matter are the ones where a plausible implementation silently
 * does the wrong thing — treating the bot's own echo as user input, or losing
 * the context token a reply must carry.
 */

import { describe, expect, it } from 'vitest'
import { parseInboundMessage, type WeixinMessage } from '../../src/wechat/inbound.ts'

/**
 * A message as the server sends it: only the fields under test are set.
 *
 * `omit` removes fields rather than setting them to `undefined`, because an
 * absent field and a present-but-undefined one are different types here and
 * the wire cannot send the latter.
 */
function message(overrides: Partial<WeixinMessage> = {}, omit: (keyof WeixinMessage)[] = []): WeixinMessage {
  const base: WeixinMessage = {
    message_id: 1,
    from_user_id: 'user-7',
    to_user_id: 'bot-9',
    message_type: 1,
    message_state: 2,
    context_token: 'ctx-1',
    item_list: [{ type: 1, text_item: { text: 'hi' } }],
    ...overrides,
  }
  for (const key of omit) delete base[key]
  return base
}

describe('reading a quoted message', () => {
  it('carries the quoted text so the model knows what is being replied to', () => {
    // Without this the model sees only "这个呢?" and has no idea what "这个"
    // refers to. DSH has no native quote field, so the context has to travel as
    // part of the text.
    const parsed = parseInboundMessage(message({
      item_list: [{
        type: 1,
        text_item: { text: '这个呢？' },
        ref_msg: { message_item: { type: 1, text_item: { text: '小王今年13岁' } } },
      }],
    }))

    expect(parsed?.quote).toBe('小王今年13岁')
    // The user's own words are still the message; the quote is additional.
    expect(parsed?.text).toBe('这个呢？')
  })

  it('reads the quote from the reference title when that is all there is', () => {
    // `title` is the server's own summary of the quoted message, and some client
    // versions send only that.
    const parsed = parseInboundMessage(message({
      item_list: [{
        type: 1,
        text_item: { text: '嗯' },
        ref_msg: { title: '小王今年13岁' },
      }],
    }))

    expect(parsed?.quote).toBe('小王今年13岁')
  })

  it('joins the title and the quoted body the way the protocol describes', () => {
    // The reference implementation joins them with " | ", and both halves carry
    // information: the title is a summary, the body is the content.
    const parsed = parseInboundMessage(message({
      item_list: [{
        type: 1,
        text_item: { text: '嗯' },
        ref_msg: { title: '摘要', message_item: { type: 1, text_item: { text: '正文' } } },
      }],
    }))

    expect(parsed?.quote).toBe('摘要 | 正文')
  })

  it('quotes a media message by its label', () => {
    // Quoting an image gives no text, so the label is what tells the model what
    // kind of thing is being referred to.
    const parsed = parseInboundMessage(message({
      item_list: [{
        type: 1,
        text_item: { text: '这张' },
        ref_msg: { message_item: { type: 2, image_item: { media: { encrypt_query_param: 'p' } } } },
      }],
    }))

    expect(parsed?.quote).toBe('[图片]')
  })

  it('reports no quote for an ordinary message', () => {
    // Absent rather than empty, so the delivery path has one thing to check.
    expect(parseInboundMessage(message())?.quote).toBeUndefined()
  })

  it('never emits the empty-message placeholder as a quote', () => {
    // A real defect, found on a phone: quoting a message whose content the
    // reference did not inline produced `[引用] (空消息)`. That placeholder exists
    // to stop a blank bubble being sent for a message that parsed to nothing -
    // it is a sentinel meaning "no content", so copying it into the text claims
    // the quoted message SAID "(空消息)".
    const parsed = parseInboundMessage(message({
      item_list: [{
        type: 1,
        text_item: { text: '他父亲多大了' },
        ref_msg: { message_item: { type: 1, text_item: {} } },
      }],
    }))

    expect(parsed?.quote).toBeUndefined()
  })

  it('quotes a reference whose item can be read, even when a sibling cannot', () => {
    // The placeholder must not leak in either direction: real content still
    // comes through.
    const parsed = parseInboundMessage(message({
      item_list: [{
        type: 1,
        text_item: { text: '嗯' },
        ref_msg: { message_item: { type: 1, text_item: { text: '有内容' } } },
      }],
    }))

    expect(parsed?.quote).toBe('有内容')
  })

  it('reports that a reference existed even when its text is unreadable', () => {
    // The distinction that makes a wire shape diagnosable, and that the model
    // needs too: "no quote" and "a quote I could not read" are different
    // situations. Collapsing them hides a reply context from the model AND
    // leaves no evidence of which one happened.
    const parsed = parseInboundMessage(message({
      item_list: [{ type: 1, text_item: { text: '他妈妈呢？' }, ref_msg: { svr_id: '123' } }],
    }))

    expect(parsed?.quote).toBeUndefined()
    expect(parsed?.quoted).toBe(true)
  })

  it('reports no reference at all for an ordinary message', () => {
    // The other half of the distinction: nothing to mark, so nothing is marked.
    expect(parseInboundMessage(message())?.quoted).toBeUndefined()
  })

  it('reports a reference as present when its text was readable', () => {
    const parsed = parseInboundMessage(message({
      item_list: [{
        type: 1,
        text_item: { text: '嗯' },
        ref_msg: { message_item: { type: 1, text_item: { text: '正文' } } },
      }],
    }))

    expect(parsed?.quote).toBe('正文')
    expect(parsed?.quoted).toBe(true)
  })

  it('reports no quote when the reference carries nothing readable', () => {
    // A reference that names only a server id (no inline content) is the shape a
    // newer client sends. We have no local cache to resolve it from, so the
    // honest answer is no quote rather than an invented one.
    const parsed = parseInboundMessage(message({
      item_list: [{ type: 1, text_item: { text: '嗯' }, ref_msg: { svr_id: '9007199254740993' } }],
    }))

    expect(parsed?.quote).toBeUndefined()
  })

  it('does not mistake the quoting message\u2019s own text for the quote', () => {
    // The reply's own item sits next to the reference; reading the wrong one
    // would make the model think the user said their own message twice.
    const parsed = parseInboundMessage(message({
      item_list: [{
        type: 1,
        text_item: { text: '我的新消息' },
        ref_msg: { message_item: { type: 1, text_item: { text: '被引用的旧消息' } } },
      }],
    }))

    expect(parsed?.quote).toBe('被引用的旧消息')
    expect(parsed?.quote).not.toContain('我的新消息')
  })
})

describe('reading media out of a message', () => {
  it('describes an image by its CDN reference, not just its label', () => {
    // A `[图片]` label tells the model nothing. The descriptor is what lets the
    // channel actually fetch the bytes, which is the whole of M4's inbound half.
    const parsed = parseInboundMessage(message({
      item_list: [{
        type: 2,
        image_item: { media: { encrypt_query_param: 'p1', full_url: 'https://cdn.test/x' } },
      }],
    }))

    expect(parsed?.media).toEqual([{
      kind: 'image',
      encryptQueryParam: 'p1',
      fullUrl: 'https://cdn.test/x',
    }])
    // The label stays as the text, so a message whose media fails to download
    // still says something rather than arriving empty.
    expect(parsed?.text).toBe('[图片]')
  })

  it('prefers the image\u2019s own hex aeskey, converted to the base64 form', () => {
    // Two key fields exist and the item-level one wins. It is hex while
    // `media.aes_key` is base64, so it has to be converted here - the download
    // path takes one encoding only, and `parseAesKey` would misread raw hex.
    const parsed = parseInboundMessage(message({
      item_list: [{
        type: 2,
        image_item: {
          aeskey: '000102030405060708090a0b0c0d0e0f',
          media: { encrypt_query_param: 'p1', aes_key: 'IGNORED' },
        },
      }],
    }))

    expect(parsed?.media?.[0]?.aesKeyBase64).toBe('AAECAwQFBgcICQoLDA0ODw==')
  })

  it('keeps media.aes_key as it is, for the types that send it base64', () => {
    // File, voice, and video carry the key here already base64-encoded, and
    // re-encoding it would corrupt it.
    const parsed = parseInboundMessage(message({
      item_list: [{
        type: 4,
        file_item: { file_name: 'report.pdf', len: '2048', media: { encrypt_query_param: 'p2', aes_key: 'AAECAwQFBgcICQoLDA0ODw==' } },
      }],
    }))

    expect(parsed?.media).toEqual([{
      kind: 'file',
      encryptQueryParam: 'p2',
      aesKeyBase64: 'AAECAwQFBgcICQoLDA0ODw==',
      name: 'report.pdf',
      size: 2048,
    }])
  })

  it('describes voice and video with their media references', () => {
    // VoiceItem carried no `media` field at all before this, so voice audio
    // could not be fetched even though the server sent it.
    const voice = parseInboundMessage(message({
      item_list: [{ type: 3, voice_item: { media: { encrypt_query_param: 'p3', aes_key: 'AAECAwQFBgcICQoLDA0ODw==' }, playtime: 1200 } }],
    }))
    const video = parseInboundMessage(message({
      item_list: [{ type: 5, video_item: { media: { encrypt_query_param: 'p4', aes_key: 'AAECAwQFBgcICQoLDA0ODw==' } } }],
    }))

    expect(voice?.media?.[0]).toMatchObject({ kind: 'voice', encryptQueryParam: 'p3' })
    expect(video?.media?.[0]).toMatchObject({ kind: 'video', encryptQueryParam: 'p4' })
  })

  it('reports no media for a plain text message', () => {
    // The field must be absent rather than an empty array for the common case,
    // so the delivery path has one obvious thing to check.
    const parsed = parseInboundMessage(message())

    expect(parsed?.media).toBeUndefined()
  })

  it('skips a media item that carries nothing to download', () => {
    // An image item with no reference at all is a shape the wire permits; the
    // label still stands, but there is nothing to fetch.
    const parsed = parseInboundMessage(message({ item_list: [{ type: 2, image_item: {} }] }))

    expect(parsed?.media).toBeUndefined()
    expect(parsed?.text).toBe('[图片]')
  })

  it('describes media with no key as downloadable without decryption', () => {
    // Images may arrive unencrypted. Marking the absence rather than omitting
    // the descriptor is what lets the download path fetch them plain.
    const parsed = parseInboundMessage(message({
      item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'p5' } } }],
    }))

    expect(parsed?.media?.[0]).toEqual({ kind: 'image', encryptQueryParam: 'p5' })
  })
})

describe('reading a user message', () => {
  it('carries the text, the sender, and the token a reply must echo', () => {
    const parsed = parseInboundMessage(message())

    // `context_token` is per-message and issued only by inbound messages, so
    // dropping it makes every reply unauthenticated for the conversation.
    expect(parsed).toEqual({
      peerId: 'user-7',
      text: 'hi',
      contextToken: 'ctx-1',
      messageId: 1,
    })
  })

  it('uses the voice transcription when the message carries one', () => {
    // The protocol puts the transcription in the item's own `text`, so reading
    // only `text_item` would drop voice messages entirely.
    const parsed = parseInboundMessage(message({
      item_list: [{ type: 3, voice_item: { text: '语音转写内容' } }],
    }))

    expect(parsed?.text).toBe('语音转写内容')
  })

  it('prefers text over a media item in the same message', () => {
    const parsed = parseInboundMessage(message({
      item_list: [
        { type: 2, image_item: { media: { encrypt_query_param: 'p' } } },
        { type: 1, text_item: { text: 'look at this' } },
      ],
    }))

    expect(parsed?.text).toBe('look at this')
  })

  it('names a media-only message instead of returning empty text', () => {
    // An image with no caption still has to reach the agent as something; an
    // empty string would look like a blank message a user never sent.
    const parsed = parseInboundMessage(message({
      item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'p' } } }],
    }))

    expect(parsed?.text).toBeTruthy()
  })
})

describe('messages that are not user input', () => {
  it('ignores the bot\u2019s own message', () => {
    // Every reply we send echoes back through getUpdates as message_type 2.
    // Treating one as input would make the channel talk to itself.
    expect(parseInboundMessage(message({ message_type: 2 }))).toBeUndefined()
  })

  it('ignores a message that is still being generated', () => {
    // state 1 is an in-progress placeholder; acting on it feeds a partial turn
    // into the agent, and state 2 arrives later with the same content.
    expect(parseInboundMessage(message({ message_state: 1 }))).toBeUndefined()
  })

  it('ignores a message with no sender', () => {
    expect(parseInboundMessage(message({ from_user_id: '' }))).toBeUndefined()
  })

  it('keeps a message whose token is missing, rather than dropping user input', () => {
    // The protocol says the client logs and continues without a token. Dropping
    // the message would lose what the user typed; dropping the token only
    // weakens the reply.
    const parsed = parseInboundMessage(message({}, ['context_token']))

    expect(parsed?.text).toBe('hi')
    expect(parsed?.contextToken).toBeUndefined()
  })

  it('keeps a message with no item list, so the user is at least acknowledged', () => {
    // Defensive: `item_list` is optional in the protocol types.
    const parsed = parseInboundMessage(message({}, ['item_list']))

    expect(parsed?.peerId).toBe('user-7')
  })
})

describe('message identity', () => {
  it('falls back to the sequence number when message_id is absent', () => {
    // The id is what the reply is correlated against, and `message_id` is
    // optional in the protocol types.
    const parsed = parseInboundMessage(message({ seq: 42 }, ['message_id']))

    expect(parsed?.messageId).toBe(42)
  })
})
