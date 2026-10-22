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
import type { ModelCommandContext, ModelListing } from '../../src/bridge/model-commands.ts'
import { createModelCommands } from '../../src/channel/model-config.ts'

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
  /** Sends the files the agent declared as deliverables. */
  sendDeliverables?: (peerId: string, files: readonly { path: string; description?: string }[]) => Promise<void>
  /** Observes a reference whose content never arrived. */
  onUnreadableQuote?: (detail: unknown) => void
  /** What `/models` and `/model` read and write. */
  models?: ModelCommandContext
  /** The typing indicator, when the test observes its lifecycle. */
  typing?: { start: (peerId: string) => Promise<void>; stop: (peerId: string) => Promise<void> }
  /** Longest text one message may carry; a longer reply is split. */
  maxMessageChars?: number
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
    ...(options.sendDeliverables === undefined ? {} : { sendDeliverables: options.sendDeliverables }),
    ...(options.onUnreadableQuote === undefined ? {} : { onUnreadableQuote: options.onUnreadableQuote }),
    ...(options.typing === undefined ? {} : { typing: options.typing }),
    // Wired from the registry's own record, so a rotated id the test declares
    // existing is resumed rather than created - which is what proves a restart
    // lands on the new conversation.
    sessionExists: async sessionId => options.registry.exists(sessionId),
    ...(options.models === undefined ? {} : { models: options.models }),
    ...(options.maxMessageChars === undefined ? {} : { maxMessageChars: options.maxMessageChars }),
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

  it('sends nothing for the partial message an interrupted turn commits', async () => {
    // `/stop` aborts the stream, and the agent loop settles what it had with
    // `interrupted: true`. Routing that through the channel is what the user
    // would actually receive, so the silence has to hold here, not only in the
    // extractor's own unit test.
    const f = fakeRegistry()
    const { channel, sent } = build({
      registry: f,
      messages: [{ message_id: 1, from_user_id: 'user-7', message_type: 1, item_list: [{ type: 1, text_item: { text: 'hi' } }] }],
    })

    await channel.run()
    await channel.settled()
    channel.onSessionEvent('channel-wechat-user-7', {
      type: 'assistant/message',
      data: {
        message: { content: [{ type: 'text', text: 'I was about to expl' }] },
        interrupted: true,
      },
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

describe('delivering a message that quoted another', () => {
  it('carries the quoted text through to the agent', async () => {
    // The wiring, which no unit test can see: the parser produces `quote` and
    // `buildUserMessage` consumes it, so only a real poll proves the channel
    // passes it between them rather than dropping it at the seam.
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
        item_list: [{
          type: 1,
          text_item: { text: '这个呢？' },
          ref_msg: { message_item: { type: 1, text_item: { text: '小王今年13岁' } } },
        }],
      }],
    })

    await channel.run()
    await channel.settled()

    expect(delivered[0]?.content).toEqual([
      { type: 'text', text: '[引用] 小王今年13岁\n这个呢？' },
    ])
    await channel.stop()
  })

  it('tells the agent a reference existed when its content could not be read', async () => {
    // The wire shape seen on a real phone: a reference present, its content
    // omitted. The model must still learn that the user is replying to
    // something - and the channel must carry the flag between the two modules.
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
        item_list: [{
          type: 1,
          text_item: { text: '他妈妈呢？' },
          ref_msg: { svr_id: '9007199254740993' },
        }],
      }],
    })

    await channel.run()
    await channel.settled()

    expect(delivered[0]?.content).toEqual([
      { type: 'text', text: '[引用] （引用的消息内容未能读取）\n他妈妈呢？' },
    ])
    await channel.stop()
  })

  it('reports the unreadable reference so the wire shape is diagnosable', async () => {
    // Without this line the two situations are indistinguishable from outside the
    // process, and the only way to tell them apart is a screenshot of a phone.
    const f = fakeRegistry()
    const reported: unknown[] = []
    const { channel } = build({
      registry: f,
      onUnreadableQuote: detail => { reported.push(detail) },
      messages: [{
        message_id: 1, from_user_id: 'user-7', message_type: 1,
        context_token: 'ctx-1',
        item_list: [{ type: 1, text_item: { text: '他妈妈呢？' }, ref_msg: { svr_id: '123' } }],
      }],
    })

    await channel.run()
    await channel.settled()

    expect(reported).toEqual(['from user-7'])
    await channel.stop()
  })

  it('does not report an ordinary message as an unreadable reference', async () => {
    // The report must be about a real reference, or it becomes noise that hides
    // the case it exists for.
    const f = fakeRegistry()
    const reported: unknown[] = []
    const { channel } = build({
      registry: f,
      onUnreadableQuote: detail => { reported.push(detail) },
      messages: [{
        message_id: 1, from_user_id: 'user-7', message_type: 1,
        context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: 'hi' } }],
      }],
    })

    await channel.run()
    await channel.settled()

    expect(reported).toEqual([])
    await channel.stop()
  })

  it('leaves an ordinary message unmarked', async () => {
    // The marker must not appear in front of every message in the conversation.
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
        message_id: 1, from_user_id: 'user-7', message_type: 1,
        context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: 'hi' } }],
      }],
    })

    await channel.run()
    await channel.settled()

    expect(delivered[0]?.content).toEqual([{ type: 'text', text: 'hi' }])
    await channel.stop()
  })
})

describe('sending the files the agent declared', () => {
  it('sends a presented file to the conversation that produced it', async () => {
    // The wiring, which no unit test can see: `presentedFilesFrom` is tested on
    // its own and the upload is tested on its own, so only a real event through
    // the channel proves the two are joined - and proves the peer is resolved
    // from the session rather than guessed.
    const f = fakeRegistry()
    const sent: { peerId: string; files: readonly { path: string; description?: string }[] }[] = []
    // Driven through the real poll loop: the session-to-peer mapping is built as
    // the message is delivered, and `handleMessage` is private precisely so that
    // this path is the only one tests take.
    const { channel } = build({
      registry: f,
      sendDeliverables: async (peerId, files) => { sent.push({ peerId, files }) },
      messages: [{
        message_id: 1, from_user_id: 'user-7', message_type: 1,
        context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: 'hi' } }],
      }],
    })

    await channel.run()
    await channel.settled()
    const sessionId = 'channel-wechat-user-7'
    channel.onSessionEvent(sessionId, {
      type: 'deliverables/presented',
      data: { turn: 1, callId: 'c1', files: [{ path: '/w/report.xlsx', description: '报表' }] },
    })
    // Delivery is detached from the event, so the assertion waits.
    await until(() => sent.length > 0, 2_000)

    expect(sent).toEqual([{ peerId: 'user-7', files: [{ path: '/w/report.xlsx', description: '报表' }] }])
    await channel.stop()
  })

  it('ignores a present event for a session this channel does not own', async () => {
    // A second channel instance, or the same profile's GUI, would otherwise
    // receive files belonging to a conversation it knows nothing about.
    const f = fakeRegistry()
    const sent: unknown[] = []
    const { channel } = build({
      registry: f,
      sendDeliverables: async (peerId, files) => { sent.push({ peerId, files }) },
    })

    channel.onSessionEvent('someone-elses-session', {
      type: 'deliverables/presented',
      data: { turn: 1, callId: 'c1', files: [{ path: '/w/x.pdf' }] },
    })
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(sent).toEqual([])
  })

  it('resolves a relative path against the session working directory', async () => {
    // The tool documents relative paths as relative to the Session cwd; a plugin
    // process has a different one, so reading the raw value would look in the
    // wrong place. The real `Session` carries it on its header.
    const f = fakeRegistry()
    const sent: { files: readonly { path: string }[] }[] = []
    const { channel } = build({
      registry: f,
      sendDeliverables: async (_peerId, files) => { sent.push({ files }) },
      messages: [{
        message_id: 1, from_user_id: 'user-7', message_type: 1,
        context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: 'hi' } }],
      }],
    })

    await channel.run()
    await channel.settled()
    // The working directory the real `session/event` listener reads off the
    // session's header, passed explicitly so the routing is testable here.
    channel.onSessionEvent('channel-wechat-user-7', {
      type: 'deliverables/presented',
      data: { turn: 1, callId: 'c1', files: [{ path: 'out/report.xlsx' }] },
    }, '/work/here')
    await until(() => sent.length > 0, 2_000)

    expect(sent[0]?.files).toEqual([{ path: '/work/here/out/report.xlsx' }])
    await channel.stop()
  })

  it('does not send anything for an unrelated session event', async () => {
    // The listener runs on every append; sending on anything but a present would
    // flood the user with the agent's intermediate files.
    const f = fakeRegistry()
    const sent: unknown[] = []
    const { channel } = build({
      registry: f,
      sendDeliverables: async (peerId, files) => { sent.push({ peerId, files }) },
      messages: [{
        message_id: 1, from_user_id: 'user-7', message_type: 1,
        context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: 'hi' } }],
      }],
    })

    await channel.run()
    await channel.settled()
    channel.onSessionEvent('channel-wechat-user-7', { type: 'assistant/message', data: { text: 'hi' } })
    channel.onSessionEvent('channel-wechat-user-7', {
      type: 'workspace/changes',
      data: { turn: 1, files: [{ path: '/w/scratch.tmp' }] },
    })
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(sent).toEqual([])
    await channel.stop()
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

describe('the typing indicator around a turn', () => {
  /** Records the lifecycle calls a turn made. */
  function spyTyping() {
    const calls: string[] = []
    return {
      calls,
      typing: {
        start: async (peerId: string) => { calls.push(`start:${peerId}`) },
        stop: async (peerId: string) => { calls.push(`stop:${peerId}`) },
      },
    }
  }

  it('shows the indicator for a delivered turn and withdraws it after', async () => {
    // Both halves matter: an indicator that never goes away reads as a hung
    // bot, and one that never appears is the state this feature replaces.
    const f = fakeRegistry()
    const spy = spyTyping()
    const { channel } = build({
      registry: f,
      messages: [{ message_id: 1, from_user_id: 'user-7', message_type: 1, item_list: [{ type: 1, text_item: { text: 'hi' } }] }],
      typing: spy.typing,
    })

    await channel.run()
    await channel.settled()

    expect(spy.calls).toEqual(['start:user-7', 'stop:user-7'])
  })

  it('does not show it for a command, which is answered without a turn', async () => {
    // `/status` is answered by the channel itself. Showing "typing" while
    // nothing is being generated would be a lie, and the command path returns
    // before the turn begins.
    const f = fakeRegistry()
    const spy = spyTyping()
    const { channel } = build({
      registry: f,
      messages: [{ message_id: 1, from_user_id: 'user-7', message_type: 1, context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: '/status' } }] }],
      typing: spy.typing,
    })

    await channel.run()
    await channel.settled()

    expect(spy.calls).toEqual([])
  })

  it('withdraws the indicator when the turn fails', async () => {
    // A failed turn is exactly when an indicator left running is most
    // misleading: the user waits for a reply that is never coming.
    const calls: string[] = []
    const f = fakeRegistry()
    // The turn fails where the channel waits for it, which is the path a
    // provider error takes: `whenIdle` is where the channel learns the turn
    // settled, so throwing there is the failure the indicator must survive.
    f.registry.create = async ({ sessionId }: { sessionId: string }) => {
      const agent = {
        id: sessionId,
        followup: () => {},
        whenIdle: async () => { throw new Error('turn failed') },
      }
      f.live.set(sessionId, agent)
      return { agent, dispose: async () => void f.live.delete(sessionId) }
    }
    const { channel } = build({
      registry: f,
      messages: [{ message_id: 1, from_user_id: 'user-7', message_type: 1, item_list: [{ type: 1, text_item: { text: 'hi' } }] }],
      typing: {
        start: async (peerId: string) => { calls.push(`start:${peerId}`) },
        stop: async (peerId: string) => { calls.push(`stop:${peerId}`) },
      },
    })

    await channel.run()
    await channel.settled()

    expect(calls).toEqual(['start:user-7', 'stop:user-7'])
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

  it('sends the answer of a turn that commits while stopping', { timeout: 10_000 }, async () => {
    // The order of `stop()` is what keeps this reply. Draining the queue before
    // the turn settles looks correct and is not: the turn commits its
    // `assistant/message` *after* that drain, so the answer is enqueued into a
    // queue nobody waits on again - and WeChat never replays it. The user sees
    // narration and no conclusion, which is exactly the report that led here.
    const sent: { peerId: string; text: string }[] = []
    const sessionId = 'channel-wechat-user-7'
    let deliver: () => void = () => {}
    /** Resolved by the test once the turn has started. */
    const started = new Promise<void>(resolve => { deliver = resolve })
    let blocked: () => void = () => {}
    /** Resolved once the turn is parked in `whenIdle`, which `stop()` must wait for. */
    const atIdle = new Promise<void>(resolve => { blocked = resolve })
    let channelRef: Channel | undefined
    let answer: (() => void) | undefined
    const agent = {
      id: sessionId,
      followup: () => { deliver() },
      whenIdle: async () => {
        // Signals that the turn is now blocked here, which is the state `stop()`
        // must wait for rather than skip past.
        blocked()
        await new Promise<void>(resolve => { answer = resolve })
        channelRef?.onSessionEvent(sessionId, {
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'the answer' }] } },
        })
      },
    }
    const channel = new Channel({
      registry: {
        create: async () => ({ agent, dispose: async () => {} }),
        resume: async () => ({ agent, dispose: async () => {} }),
        get: () => agent,
      } as never,
      // The message once, then nothing: a poll that kept returning it would
      // start a new turn on every iteration.
      poll: (() => {
        let served = false
        return async () => {
          if (served) return { msgs: [], get_updates_buf: 'c1' }
          served = true
          return {
            msgs: [{ message_id: 1, from_user_id: 'user-7', message_type: 1, item_list: [{ type: 1, text_item: { text: 'hi' } }] }],
            get_updates_buf: 'c1',
          }
        }
      })(),
      // Asynchronous on purpose: a send that completed within the same microtask
      // batch would let a wrongly ordered `stop()` look correct, because the
      // reply would already be delivered by the time `stop()` returned.
      send: async (peerId, text) => {
        await new Promise(resolve => setTimeout(resolve, 10))
        sent.push({ peerId, text })
      },
      saveCursor: async () => {},
      sleep: async () => {},
      now: () => 0,
      pollTimeoutMs: 1_000,
      maxRunMs: 600_000,
    })
    channelRef = channel
    channels.push(channel)

    // Not awaited: the loop runs until `stop()` ends it, and the turn under test
    // is what `stop()` must wait for.
    void channel.run()
    await started
    // Waited for rather than assumed: the turn only blocks in `whenIdle` after
    // the handler has prepared it, and releasing before that would let the test
    // pass without ever exercising the ordering.
    await atIdle
    // The release is deferred by a tick on purpose. `stop()` must still be
    // waiting when the turn commits, because the answer does not exist before
    // that - a stop that drains the queue first has nothing to wait on and
    // returns with the reply still queued.
    const stopping = channel.stop()
    await new Promise(resolve => setTimeout(resolve, 0))
    answer?.()

    await stopping

    // Asserted at the moment `stop()` returns, which is the whole point: a stop
    // that drained before the turn settled returns here with the reply still
    // queued, and the process would then exit without it.
    expect(sent.map(entry => entry.text)).toEqual(['the answer'])
  })
})



describe('/models and /model over the production wiring', () => {
  const llm = {
    listProviders: () => [
      { id: 'provider-a', name: 'Provider A' },
      { id: 'provider-b', name: 'Provider B' },
    ],
    listModels: async (provider: string) => provider === 'provider-a'
      ? [{ id: 'model-a1', name: 'A1' }]
      : [{ id: 'model-b1', name: 'B1' }],
  }

  /** A context with just what `createModelCommands` reads, plus a never-settling edit. */
  function modelContext(options: { editNeverSettles?: boolean } = {}) {
    const written: Record<string, unknown>[] = []
    const reported: unknown[] = []
    const ctx = {
      get: (name: string) => name === 'configEditor'
        ? {
            edit: async (_entry: unknown, change: (current: Record<string, unknown>) => Record<string, unknown>) => {
              written.push(change({ provider: '', model: '', cwd: '/work' }))
              // A real reload disposes this run, whose teardown awaits in-flight
              // commands - so from the command's side the write never settles.
              if (options.editNeverSettles === true) await new Promise<void>(() => {})
            },
          }
        : undefined,
      fiber: { entry: {} },
    }
    const models = createModelCommands(
      ctx as never,
      { provider: { get: () => '' }, model: { get: () => '' } },
      llm,
      (message, detail) => { reported.push([message, detail]) },
    )
    return { models, written, reported }
  }

  it('answers /models without opening a session', async () => {
    // A pure query must not create the conversation it asks about: the peer may
    // have none, and creating one to answer "which models exist" is a side
    // effect nobody asked for.
    const f = fakeRegistry()
    const { models } = modelContext()
    const { channel, sent } = build({
      registry: f,
      messages: [{ message_id: 1, from_user_id: 'user-7', message_type: 1, item_list: [{ type: 1, text_item: { text: '/models' } }] }],
      models,
    })

    await channel.run()
    await channel.settled()

    expect(sent.map(entry => entry.text).join('')).toContain('/provider-b/model-b1')
    // No session was opened: the registry's live map is still empty.
    expect([...f.live.keys()]).toEqual([])
  })

  it('answers /model and drains even though the write never settles', { timeout: 5_000 }, async () => {
    // The deadlock this covers: a real write reloads this plugin's row, the
    // reload disposes the row, the row's disposer awaits `Channel.stop()`, and
    // `stop()` awaits every in-flight command - this one. Awaiting the write in
    // the command would make `settled()` never return, which is what the Host's
    // shutdown deadline then reports as a failed teardown.
    const f = fakeRegistry()
    const { models, written } = modelContext({ editNeverSettles: true })
    const { channel, sent } = build({
      registry: f,
      messages: [{ message_id: 1, from_user_id: 'user-7', message_type: 1, item_list: [{ type: 1, text_item: { text: '/model provider-b/model-b1' } }] }],
      models,
    })

    await channel.run()
    await channel.settled()

    expect(sent.map(entry => entry.text).join('')).toContain('provider-b/model-b1')
    expect(written).toEqual([{ provider: 'provider-b', model: 'model-b1', cwd: '/work' }])
  })

  it('refuses an unknown model without writing', async () => {
    const f = fakeRegistry()
    const { models, written } = modelContext()
    const { channel, sent } = build({
      registry: f,
      messages: [{ message_id: 1, from_user_id: 'user-7', message_type: 1, item_list: [{ type: 1, text_item: { text: '/model provider-a/nope' } }] }],
      models,
    })

    await channel.run()
    await channel.settled()

    expect(written).toEqual([])
    expect(sent.map(entry => entry.text).join('')).toContain('nope')
  })
})

describe('sending a long answer', () => {
  it('splits it into messages the transport will accept', async () => {
    // The transport refuses a body past its limit and WeChat never replays, so an
    // unsplit over-long answer is lost rather than truncated. Each piece goes
    // through the queue, which keeps them in order.
    const f = fakeRegistry()
    const { channel, sent } = build({
      registry: f,
      messages: [{ message_id: 1, from_user_id: 'user-7', message_type: 1, context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: 'hi' } }] }],
      maxMessageChars: 40,
    })

    await channel.run()
    await channel.settled()
    const answer = `${'a'.repeat(30)}\n\n${'b'.repeat(30)}\n\n${'c'.repeat(30)}`
    channel.onSessionEvent('channel-wechat-user-7', {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: answer }] } },
    })
    await channel.settled()

    expect(sent.length).toBeGreaterThan(1)
    expect(sent.every(entry => entry.text.length <= 40)).toBe(true)
    // Every piece reaches the same conversation with the same token.
    expect(sent.every(entry => entry.peerId === 'user-7' && entry.token === 'ctx-1')).toBe(true)
    expect(sent.map(entry => entry.text).join('')).toBe(answer.replace(/\s+/gu, ''))
  })

  it('sends a short answer as one message', async () => {
    // The ordinary case must not be reflowed into several bubbles.
    const f = fakeRegistry()
    const { channel, sent } = build({
      registry: f,
      messages: [{ message_id: 1, from_user_id: 'user-7', message_type: 1, item_list: [{ type: 1, text_item: { text: 'hi' } }] }],
      maxMessageChars: 40,
    })

    await channel.run()
    await channel.settled()
    channel.onSessionEvent('channel-wechat-user-7', {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'short answer' }] } },
    })
    await channel.settled()

    expect(sent.map(entry => entry.text)).toEqual(['short answer'])
  })
})
