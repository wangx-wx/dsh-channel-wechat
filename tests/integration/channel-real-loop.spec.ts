/**
 * The channel over a real agent loop.
 *
 * Everything else in this suite stubs the registry. This one does not: it
 * mounts the production agent loop, registers a scripted model adapter, and
 * drives a message through to a committed `assistant/message` — which is the
 * event the reply path actually reads. That is the difference between "the
 * pieces are wired to something registry-shaped" and "the pieces are wired to
 * the thing the harness runs".
 *
 * The only stand-ins are the two platform boundaries: the poll and the WeChat
 * send.
 */

import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { Channel } from '../../src/channel/channel.ts'

/** A model that answers every call with one fixed line of text. */
class ScriptedAdapter extends LlmAdapter {
  /** @param reply - the text every call produces. */
  constructor(private readonly reply: string) {
    super()
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const contexts: Context[] = []
const channels: Channel[] = []

afterEach(async () => {
  while (channels.length > 0) await channels.pop()?.stop()
  while (contexts.length > 0) await contexts.pop()?.fiber.dispose()
})

/**
 * Mount a real loop and a channel over it.
 * @param reply - what the scripted model answers.
 * @param messages - the messages the first poll returns.
 */
async function boot(reply: string, messages: unknown[]) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  // Registered before any work starts; the loop resolves its adapter per call.
  ctx.llm.registerAdapter(['wechat-scripted'], new ScriptedAdapter(reply))

  const sent: { peerId: string; text: string; token: string | undefined }[] = []
  let clock = 0
  let polls = 0

  const channel = new Channel({
    registry: ctx.agents as never,
    poll: async () => {
      polls += 1
      return polls === 1 ? { msgs: messages, get_updates_buf: 'c1' } : { msgs: [], get_updates_buf: 'c1' }
    },
    send: async (peerId, text, token) => void sent.push({ peerId, text, token }),
    saveCursor: async () => {},
    sleep: async (ms: number) => { clock += ms },
    now: () => clock,
    pollTimeoutMs: 1_000,
    maxRunMs: 3_000,
    // The session must select the scripted provider; otherwise the loop asks
    // the environment's model configuration and no adapter matches.
    sessionOptions: { provider: 'wechat-scripted', model: 'scripted' },
  })
  // The production wiring: the channel listens to committed session events, so
  // the model's answer has a route back out.
  channel.attach(ctx as never)
  channels.push(channel)

  return { ctx, channel, sent, harness, polls: () => polls }
}

/** A wire message from one peer. */
function inbound(text: string, token = 'ctx-1') {
  return {
    message_id: 1,
    from_user_id: 'user-7',
    message_type: 1,
    message_state: 2,
    context_token: token,
    item_list: [{ type: 1, text_item: { text } }],
  }
}

describe('a real agent answers a WeChat message', () => {
  it('turns a polled message into the assistant text sent back to WeChat', async () => {
    const { channel, sent } = await boot('hello from the model', [inbound('hi')])

    await channel.run()
    await channel.settled()

    // The whole chain in one assertion: poll -> parse -> session -> real model
    // loop -> committed assistant/message -> reply queue -> WeChat send.
    expect(sent).toEqual([{ peerId: 'user-7', text: 'hello from the model', token: 'ctx-1' }])
  })

  it('commits the user message to the session log', async () => {
    // Delivery is only "durable" if the message actually reaches the log; this
    // is what the plan's requirement of model-visibility means in practice.
    //
    // `snapshotEvents` is deprecated for production use, but reading back a log
    // in a test is exactly the observation it still provides, and the
    // alternative is querying through a wire interface this test does not need.
    const { ctx, channel } = await boot('ok', [inbound('remember me')])

    await channel.run()
    await channel.settled()

    const session = ctx.agents.get(SessionId('channel-wechat-user-7'))
    const events = session?.session.snapshotEvents() ?? []
    const userMessage = events.find(event => event.type === 'user/message')
    expect(JSON.stringify(userMessage)).toContain('remember me')
  })
})

describe('a message with no answer still reaches the agent', () => {
  it('does not send anything when the model produces no text', async () => {
    // A tool-only turn is a real outcome; sending an empty bubble is not.
    const { channel, sent } = await boot('', [inbound('do something')])

    await channel.run()
    await channel.settled()

    expect(sent).toEqual([])
  })
})
