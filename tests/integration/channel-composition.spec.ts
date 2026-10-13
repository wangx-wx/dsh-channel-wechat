/**
 * The channel: all five pieces wired together.
 *
 * Each piece has its own suite. What is left to prove is the wiring — that a
 * polled message reaches a session and that the answer comes back out — over a
 * real cordis context, with only the two platform boundaries (the poll and the
 * transport send) injected.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Channel } from '../../src/channel/channel.ts'
import type { ReplySender } from '../../src/bridge/reply.ts'
import type { InboundMedia } from '../../src/wechat/inbound.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** Wait until a condition holds, so a background loop has a chance to run. */
async function until(check: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('condition never held')
}

/** A registry that records what was created and what was delivered to it. */
function fakeRegistry(options: { existing?: readonly string[] } = {}) {
  const followed: { sessionId: string; text: string }[] = []
  const live = new Map<string, unknown>()
  /** Whether a session id already has persisted state, as the real probe asks. */
  const exists = (sessionId: string): boolean => (options.existing ?? []).includes(sessionId)

  return {
    followed,
    live,
    registry: {
      async create({ sessionId }: { sessionId: string }) {
        const agent = {
          id: sessionId,
          followup: (message: { content: readonly { text?: string }[] }) => {
            followed.push({ sessionId, text: message.content.map(block => block.text ?? '').join('') })
          },
        }
        live.set(sessionId, agent)
        return { agent, dispose: async () => void live.delete(sessionId) }
      },
      async resume({ resumeSessionId }: { resumeSessionId: string }) {
        const agent = {
          id: resumeSessionId,
          followup: (message: { content: readonly { text?: string }[] }) => {
            followed.push({ sessionId: resumeSessionId, text: message.content.map(block => block.text ?? '').join('') })
          },
        }
        live.set(resumeSessionId, agent)
        return { agent, dispose: async () => void live.delete(resumeSessionId) }
      },
      get(sessionId: string) {
        return live.get(sessionId)
      },
    },
    exists,
  }
}

const channels: Channel[] = []

afterEach(async () => {
  while (channels.length > 0) await channels.pop()?.stop()
})

/** Build a channel over injected boundaries. */
function build(options: {
  registry: ReturnType<typeof fakeRegistry>
  messages?: unknown[]
  send?: ReplySender
  onReplyError?: (error: unknown, peerId: string, text: string) => void
  /** Called when a turn begins, so a test can see one in flight. */
  onTurnStarted?: () => void
  /** Replaces the command router's cancel, for /stop tests. */
  cancelRunning?: () => Promise<boolean>
  /** Where conversation generations are kept, for /new tests. */
  generations?: { generation: (peerId: string) => Promise<number>; startNew: (peerId: string) => Promise<number> }
  /** The card answerer, for the queue-bypass tests. */
  cards?: { addressesCard: (text: string) => boolean; answer: (peerId: string, text: string) => Promise<boolean>; dispose: () => void }
  /** Turns a message's media into content blocks; absent means none is supported. */
  prepareMedia?: (media: readonly InboundMedia[]) => Promise<{ parts: readonly ContentBlock[]; notes: readonly string[] }>
}) {
  const polls: (string | undefined)[] = []
  const sent: { peerId: string; text: string; token: string | undefined }[] = []
  let pollsDone = 0
  // The clock advances with the sleeps. A frozen one never reaches the run
  // limit, so a loop that has nothing left to poll would spin forever.
  let clock = 0

  const channel = new Channel({
    registry: options.registry.registry as never,
    poll: async (cursor) => {
      polls.push(cursor)
      pollsDone += 1
      return pollsDone === 1
        ? { msgs: options.messages ?? [], get_updates_buf: 'c1' }
        : { msgs: [], get_updates_buf: 'c1' }
    },
    send: options.send ?? (async (peerId, text, token) => void sent.push({ peerId, text, token })),
    saveCursor: async () => {},
    sleep: async (ms: number) => { clock += ms },
    now: () => clock,
    pollTimeoutMs: 1_000,
    maxRunMs: 2_000,
    ...(options.onReplyError === undefined ? {} : { onReplyError: options.onReplyError }),
    ...(options.onTurnStarted === undefined ? {} : { onTurnStarted: options.onTurnStarted }),
    ...(options.cancelRunning === undefined ? {} : { cancelRunning: options.cancelRunning }),
    // The harness's command runtime; the channel forwards unknown names to it.
    executeNativeCommand: async (line: string) => ({ kind: 'success' as const, text: `native: ${line}` }),
    ...(options.generations === undefined ? {} : { generations: options.generations }),
    ...(options.cards === undefined ? {} : { cards: options.cards }),
    ...(options.prepareMedia === undefined ? {} : { prepareMedia: options.prepareMedia }),
    // Wired from the registry's own record, so a rotated id the test declares
    // existing is resumed rather than created - which is what proves a restart
    // lands on the new conversation.
    sessionExists: async sessionId => options.registry.exists(sessionId),
  })
  channels.push(channel)
  return { channel, polls, sent }
}

describe('a polled message reaches its session', () => {
  it('delivers the parsed text to the session for that peer', async () => {
    const f = fakeRegistry()
    const { channel } = build({
      registry: f,
      messages: [{ message_id: 1, from_user_id: 'user-7', message_type: 1, message_state: 2, item_list: [{ type: 1, text_item: { text: 'hi' } }] }],
    })

    await channel.run()
    await channel.settled()

    expect(f.followed).toEqual([{ sessionId: 'channel-wechat-user-7', text: 'hi' }])
  })

  it('skips the bot\u2019s own echo instead of delivering it', async () => {
    const f = fakeRegistry()
    const { channel } = build({
      registry: f,
      messages: [{ message_id: 2, from_user_id: 'bot-9', message_type: 2, message_state: 2, item_list: [{ type: 1, text_item: { text: 'our own reply' } }] }],
    })

    await channel.run()
    await channel.settled()

    expect(f.followed).toEqual([])
  })

  it('routes two peers to two sessions', async () => {
    const f = fakeRegistry()
    const { channel } = build({
      registry: f,
      messages: [
        { message_id: 1, from_user_id: 'user-7', message_type: 1, item_list: [{ type: 1, text_item: { text: 'from seven' } }] },
        { message_id: 2, from_user_id: 'user-8', message_type: 1, item_list: [{ type: 1, text_item: { text: 'from eight' } }] },
      ],
    })

    await channel.run()
    await channel.settled()

    expect(f.followed.map(entry => entry.sessionId).sort())
      .toEqual(['channel-wechat-user-7', 'channel-wechat-user-8'])
  })
})

describe('the answer comes back out', () => {
  it('sends the assistant text for the peer whose session produced it', async () => {
    const f = fakeRegistry()
    const { channel, sent } = build({
      registry: f,
      messages: [{ message_id: 1, from_user_id: 'user-7', message_type: 1, context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: 'hi' } }] }],
    })

    await channel.run()
    await channel.settled()
    // This is what the plugin passes from `ctx.on('session/event', ...)`.
    channel.onSessionEvent('channel-wechat-user-7', {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'hello back' }] } },
    })
    await channel.settled()

    expect(sent).toEqual([{ peerId: 'user-7', text: 'hello back', token: 'ctx-1' }])
  })

  it('remembers the token the conversation issued', async () => {
    // The token is per-message and only arrives inbound; without remembering it
    // the reply would be unauthenticated for the conversation.
    const f = fakeRegistry()
    const { channel, sent } = build({
      registry: f,
      messages: [{ message_id: 1, from_user_id: 'user-7', message_type: 1, context_token: 'ctx-abc', item_list: [{ type: 1, text_item: { text: 'hi' } }] }],
    })

    await channel.run()
    await channel.settled()
    channel.onSessionEvent('channel-wechat-user-7', {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'reply' }] } },
    })
    await channel.settled()

    expect(sent[0]?.token).toBe('ctx-abc')
  })

  it('ignores a session this channel does not own', async () => {
    const f = fakeRegistry()
    const { channel, sent } = build({ registry: f })

    await channel.run()
    await channel.settled()
    channel.onSessionEvent('some-other-plugin-session', {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'unsolicited' }] } },
    })
    await channel.settled()

    // Another plugin's session is not this channel's to answer for.
    expect(sent).toEqual([])
  })

  it('ignores a session event that carries no assistant text', async () => {
    const f = fakeRegistry()
    const { channel, sent } = build({
      registry: f,
      messages: [{ message_id: 1, from_user_id: 'user-7', message_type: 1, item_list: [{ type: 1, text_item: { text: 'hi' } }] }],
    })

    await channel.run()
    await channel.settled()
    // A tool-only turn has no prose to send.
    channel.onSessionEvent('channel-wechat-user-7', {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'tool-call', name: 'bash' }] } },
    })
    await channel.settled()

    expect(sent).toEqual([])
  })
})

describe('slash commands', () => {
  it('answers a command without starting a model turn', async () => {
    // A command is the channel's business, not the model's: delivering
    // "/status" as a prompt would burn a turn to answer a question the channel
    // already knows the answer to.
    const f = fakeRegistry()
    const { channel, sent } = build({
      registry: f,
      messages: [{ message_id: 1, from_user_id: 'user-7', message_type: 1, context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: '/status' } }] }],
    })

    await channel.run()
    await channel.settled()

    expect(f.followed).toEqual([])
    expect(sent).toHaveLength(1)
    expect(sent[0]?.peerId).toBe('user-7')
  })

  it('runs a command even while that peer has a turn in flight', async () => {
    // This is the M3 acceptance criterion and the reason commands bypass the
    // queue: a /stop that queued behind the turn it means to stop can never
    // arrive. `turnIsRunning` reports whether the turn had already started.
    const f = fakeRegistry()
    let turnRunning = false
    let cancelled = false
    const { channel, sent } = build({
      registry: f,
      messages: [],
      onTurnStarted: () => { turnRunning = true },
      cancelRunning: async () => { cancelled = true; return true },
    })

    await channel.run()
    await channel.settled()

    // Start a turn that stays in flight, then send /stop from the same peer.
    const handler = channel as unknown as { handleMessage: (message: unknown) => Promise<void> }
    void handler.handleMessage({
      message_id: 1, from_user_id: 'user-7', message_type: 1,
      item_list: [{ type: 1, text_item: { text: 'long task' } }],
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    await handler.handleMessage({
      message_id: 2, from_user_id: 'user-7', message_type: 1,
      item_list: [{ type: 1, text_item: { text: '/stop' } }],
    })

    expect(turnRunning).toBe(true)
    expect(cancelled).toBe(true)
    expect(sent.map(entry => entry.text).join('')).toContain('停止')
  })

  it('passes an unknown command to the harness rather than the model', async () => {
    const f = fakeRegistry()
    const { channel, sent } = build({
      registry: f,
      messages: [{ message_id: 1, from_user_id: 'user-7', message_type: 1, item_list: [{ type: 1, text_item: { text: '/nonexistent-cmd' } }] }],
    })

    await channel.run()
    await channel.settled()

    expect(f.followed).toEqual([])
    expect(sent).toHaveLength(1)
  })

  it('still delivers ordinary text to the model', async () => {
    // The bypass must not swallow normal messages.
    const f = fakeRegistry()
    const { channel } = build({
      registry: f,
      messages: [{ message_id: 1, from_user_id: 'user-7', message_type: 1, item_list: [{ type: 1, text_item: { text: 'hello' } }] }],
    })

    await channel.run()
    await channel.settled()

    expect(f.followed).toEqual([{ sessionId: 'channel-wechat-user-7', text: 'hello' }])
  })
})

describe('starting a new conversation', () => {
  it('delivers the next message to a different session than the one /new ended', async () => {
    // The defect this covers: `/new` disposed the peer's handle, but a peer's
    // session id was a pure function of the peer, so the persisted session
    // survived and the next message resumed the conversation the user had just
    // been told was over. Nothing about the handle being gone is observable from
    // the reply text, so this asserts on where the message actually landed.
    const f = fakeRegistry()
    const { channel } = build({ registry: f, messages: [] })
    await channel.run()
    await channel.settled()

    const handler = channel as unknown as { handleMessage: (message: unknown) => Promise<void> }
    const fromPeer = (text: string) => ({
      message_id: 1, from_user_id: 'user-7', message_type: 1,
      context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text } }],
    })

    await handler.handleMessage(fromPeer('first'))
    await handler.handleMessage(fromPeer('/new'))
    await handler.handleMessage(fromPeer('after the new conversation'))

    const destinations = f.followed.map(entry => entry.sessionId)
    expect(destinations).toHaveLength(2)
    expect(destinations[0]).not.toBe(destinations[1])
  })

  it('honors /new across a restart through the durable generation', async () => {
    // The in-memory half of the rotation would pass the test above and still
    // resume the ended conversation after a restart. A fresh channel over a store
    // that already advanced is exactly what the next process sees.
    const rotated = 'channel-wechat-user-7~g1'
    const f = fakeRegistry({ existing: [rotated] })
    const { channel } = build({
      registry: f,
      messages: [],
      generations: { generation: async () => 1, startNew: async () => 2 },
    })

    await channel.run()
    await channel.settled()
    const handler = channel as unknown as { handleMessage: (message: unknown) => Promise<void> }
    await handler.handleMessage({
      message_id: 1, from_user_id: 'user-7', message_type: 1,
      context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: 'after a restart' } }],
    })

    expect(f.followed.map(entry => entry.sessionId)).toEqual([rotated])
  })
})

describe('delivering a message that carried media', () => {
  it('prepares the media and puts the blocks on the delivered message', async () => {
    // The wiring, which is what no unit test can see: `bridge/media` is tested
    // on its own and `buildUserMessage` is tested on its own, so only a real
    // poll through the channel proves the two are actually joined - that the
    // parser's descriptors reach the preparer and its blocks reach the agent.
    const f = fakeRegistry()
    const prepared: unknown[] = []
    const delivered: { content: readonly unknown[] }[] = []
    f.registry.create = async ({ sessionId }: { sessionId: string }) => {
      const agent = {
        id: sessionId,
        followup: (message: { content: readonly unknown[] }) => {
          delivered.push(message)
          f.followed.push({ sessionId, text: '' })
        },
      }
      f.live.set(sessionId, agent)
      return { agent, dispose: async () => void f.live.delete(sessionId) }
    }

    const { channel } = build({
      registry: f,
      messages: [{
        message_id: 1,
        from_user_id: 'user-7',
        message_type: 1,
        context_token: 'ctx-1',
        item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'p1' } } }],
      }],
      prepareMedia: async (media) => {
        prepared.push(media)
        return {
          parts: [{
            type: 'image',
            // Branded, exactly as the harness's own tests build one.
            attachment: {
              attachmentId: 'a1' as ImageAttachmentRef['attachmentId'],
              mediaType: 'image/png',
              bytes: 3,
              width: 1,
              height: 1,
            },
          }],
          notes: [],
        }
      },
    })

    await channel.run()
    await channel.settled()

    // The parser's descriptor reached the preparer...
    expect(prepared).toEqual([[
      { kind: 'image', encryptQueryParam: 'p1' },
    ]])
    // ...and the admitted block reached the agent, after the label text.
    expect(delivered[0]?.content).toEqual([
      { type: 'text', text: '[图片]' },
      { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } },
    ])
    await channel.stop()
  })

  it('delivers the message with a note when the media could not be prepared', async () => {
    // Media is an addition to what the user said: a failure must not swallow the
    // turn, so the text still arrives, carrying the reason.
    const f = fakeRegistry()
    const delivered: { content: readonly { text?: string }[] }[] = []
    f.registry.create = async ({ sessionId }: { sessionId: string }) => {
      const agent = {
        id: sessionId,
        followup: (message: { content: readonly { text?: string }[] }) => {
          delivered.push(message)
          f.followed.push({ sessionId, text: '' })
        },
      }
      f.live.set(sessionId, agent)
      return { agent, dispose: async () => void f.live.delete(sessionId) }
    }

    const { channel } = build({
      registry: f,
      messages: [{
        message_id: 1,
        from_user_id: 'user-7',
        message_type: 1,
        context_token: 'ctx-1',
        item_list: [
          { type: 1, text_item: { text: '看看这个' } },
          { type: 2, image_item: { media: { encrypt_query_param: 'p1' } } },
        ],
      }],
      prepareMedia: async () => ({ parts: [], notes: ['（这条消息里的图片未能读取：CDN 500）'] }),
    })

    await channel.run()
    await channel.settled()

    expect(delivered[0]?.content).toEqual([
      { type: 'text', text: '看看这个\n（这条消息里的图片未能读取：CDN 500）' },
    ])
    await channel.stop()
  })

  it('does not consult the preparer for a message with no media', async () => {
    // The common case must not pay for a store lookup or a download.
    const f = fakeRegistry()
    const prepareMedia = vi.fn()
    const { channel } = build({
      registry: f,
      messages: [{ message_id: 1, from_user_id: 'user-7', message_type: 1, context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: 'hi' } }] }],
      prepareMedia,
    })

    await channel.run()
    await channel.settled()

    expect(prepareMedia).not.toHaveBeenCalled()
    expect(f.followed[0]?.text).toBe('hi')
    await channel.stop()
  })
})

describe('answering a card while the turn holds the queue', () => {
  it('reaches the card even though the queue is held by that turn', async () => {
    // The hazard this exists for: the agent is inside `ask_user_question`
    // waiting for the answer, and its turn is what holds the peer's queue. A
    // reply routed through that queue could never arrive, so the card would
    // deadlock the very conversation it asks about. This is why a card reply
    // bypasses the queue exactly as `/stop` does.
    //
    // Driven through the real poll loop, because the queue lives in the loop's
    // `serialize` hook: delivering to `handleMessage` directly would skip the
    // very path under test.
    const f = fakeRegistry()
    /** Answers the channel received, in order. */
    const answered: string[] = []
    let releaseTurn: (() => void) | undefined
    const held = new Promise<void>(resolve => { releaseTurn = resolve })
    let turnStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => { turnStarted = resolve })

    // Messages the poll should deliver, in order; the test appends as it goes.
    const queue: unknown[] = [{ message_id: 1, from_user_id: 'user-7', message_type: 1, item_list: [{ type: 1, text_item: { text: 'please start' } }] }]
    let polls = 0
    let clock = 0
    const channel = new Channel({
      registry: f.registry as never,
      poll: async () => {
        polls += 1
        // One message per poll, so the loop is between them when the card is
        // answered - which is the concurrency being modelled.
        return { msgs: queue.splice(0, 1), get_updates_buf: `c${polls}` }
      },
      send: async () => {},
      saveCursor: async () => {},
      sleep: async (ms: number) => { clock += ms },
      now: () => clock,
      pollTimeoutMs: 1_000,
      maxRunMs: 5_000,
      cards: {
        // A real answerer matches only a message naming an open card, so the
        // ordinary message still reaches the model.
        addressesCard: text => text === 'P1 1',
        answer: async (_peerId, text) => {
          // A real answerer claims only the messages it addresses: the ordinary
          // message must still reach the model, and claiming it would swallow
          // the very turn whose queue this test needs held.
          if (text !== 'P1 1') return false
          answered.push(text)
          // Answering is what lets the agent continue, and continuing is what
          // ends the turn holding the queue.
          releaseTurn?.()
          return true
        },
        dispose: () => {},
      },
    })
    channels.push(channel)
    // The turn does not finish until the card is answered, which is the state
    // an agent asking a question is really in.
    f.registry.create = async ({ sessionId }: { sessionId: string }) => {
      const agent = {
        id: sessionId,
        followup: () => { turnStarted?.() },
        whenIdle: async () => { await held },
      }
      f.live.set(sessionId, agent)
      return { agent, dispose: async () => void f.live.delete(sessionId) }
    }

    const running = channel.run()
    await started
    // The agent is now blocked, holding this peer's queue.
    queue.push({ message_id: 2, from_user_id: 'user-7', message_type: 1, item_list: [{ type: 1, text_item: { text: 'P1 1' } }] })

    try {
      await until(async () => answered.length > 0, 5_000)
    } finally {
      releaseTurn?.()
      await channel.stop()
      await running
    }

    expect(answered).toEqual(['P1 1'])
  })
})

describe('stopping', () => {
  it('disposes every session it created', async () => {
    const f = fakeRegistry()
    const { channel } = build({
      registry: f,
      messages: [{ message_id: 1, from_user_id: 'user-7', message_type: 1, item_list: [{ type: 1, text_item: { text: 'hi' } }] }],
    })

    await channel.run()
    await channel.settled()
    await channel.stop()

    // An undisposed agent keeps its registry slot and write lease, so a later
    // start for the same peer would throw.
    expect(f.live.size).toBe(0)
  })

  it('stops promptly instead of waiting out the run limit', async () => {
    // A stop that waits for the deadline, or for an in-flight long poll, is a
    // stop that looks hung: the poll holds for up to 35 seconds.
    const f = fakeRegistry()
    const polls: string[] = []
    const channel = new Channel({
      registry: f.registry as never,
      poll: async () => {
        polls.push('poll')
        // Never resolves; only the abort can end this run.
        return new Promise<never>(() => {})
      },
      send: async () => {},
      saveCursor: async () => {},
      sleep: async () => {},
      now: () => 0,
      pollTimeoutMs: 1_000,
      // A generous limit, so reaching it cannot be what ends the run.
      maxRunMs: 600_000,
    })
    channels.push(channel)

    const running = channel.run()
    await new Promise(resolve => setTimeout(resolve, 10))
    await channel.stop()

    await expect(Promise.race([running, new Promise(resolve => setTimeout(() => resolve('timeout'), 500))]))
      .resolves.not.toBe('timeout')
    expect(polls).toHaveLength(1)
  })

  it('can be started again after stopping', async () => {
    const f = fakeRegistry()
    const { channel } = build({ registry: f })

    await channel.run()
    await channel.stop()

    await expect(channel.run()).resolves.toBeUndefined()
    await channel.stop()
  })
})
