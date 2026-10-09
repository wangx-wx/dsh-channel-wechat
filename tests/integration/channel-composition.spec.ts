/**
 * The channel: all five pieces wired together.
 *
 * Each piece has its own suite. What is left to prove is the wiring — that a
 * polled message reaches a session and that the answer comes back out — over a
 * real cordis context, with only the two platform boundaries (the poll and the
 * transport send) injected.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { Channel } from '../../src/channel/channel.ts'
import type { ReplySender } from '../../src/bridge/reply.ts'

/** A registry that records what was created and what was delivered to it. */
function fakeRegistry() {
  const followed: { sessionId: string; text: string }[] = []
  const live = new Map<string, unknown>()

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
