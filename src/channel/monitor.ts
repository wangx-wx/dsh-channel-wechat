/**
 * The long-poll monitor.
 *
 * WeChat has no callback, socket, or subscription: `getUpdates` is the only way
 * to receive anything, and the server holds the request open until it has a
 * message or the poll times out. That shapes everything here.
 *
 * The plan's Q36 decision is what the loop is built around: **polling and
 * processing are decoupled**. A message handler runs detached from the poll, so
 * a turn that takes a minute cannot stop the channel from receiving the message
 * that would interrupt it. The per-peer serialization is injected because it
 * belongs to the session map, not to the transport.
 *
 * A failed poll is treated as "no news" rather than as a channel failure:
 * against a 35-second long poll, a gateway timeout is routine.
 *
 * @module dsh-channel-wechat/channel/monitor
 */

/** Polls once and returns whatever the server said. */
export type PollFn = (cursor: string | undefined, timeoutMs: number) => Promise<MonitorResponse>

/** The subset of a `getUpdates` response the monitor acts on. */
export interface MonitorResponse {
  /** Messages received since the cursor. */
  msgs?: unknown[]
  /** Cursor for the next poll. */
  get_updates_buf?: string
  /** Server-suggested poll timeout in milliseconds. */
  longpolling_timeout_ms?: number
}

/** Collaborators and policy for {@link monitorLoop}. */
export interface MonitorOptions {
  /** Cursor loaded from a previous run, when there is one. */
  initialCursor: string | undefined
  /** The poll itself. */
  poll: PollFn
  /** Handle one delivered message. */
  onMessage: (message: unknown) => Promise<void> | void
  /** Persist a cursor the server returned. */
  saveCursor: (cursor: string) => Promise<void> | void
  /** Whether the loop should end; consulted before each poll. */
  shouldStop: () => boolean
  /** Run one message's work through the peer's queue. Defaults to running it directly. */
  serialize?: (message: unknown, work: () => Promise<void>) => Promise<void>
  /** Observe a handler failure; the loop continues either way. */
  onMessageError?: (error: unknown, message: unknown) => void
  /** Pause between polls; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
  /** Monotonic milliseconds; defaults to `Date.now`. */
  now?: () => number
  /** Long-poll timeout to request; defaults to 35 seconds. */
  pollTimeoutMs?: number
  /** Hard limit on how long a single `monitorLoop` call may run. */
  maxRunMs?: number
  /** Ends the loop promptly when aborted. */
  signal?: AbortSignal
}

/** The default long-poll timeout, matching the protocol's documented default. */
export const DEFAULT_POLL_TIMEOUT_MS = 35_000

/** Pause between polls when the server returned nothing to wait on. */
const IDLE_INTERVAL_MS = 1_000

/** How long a single call may run before it gives up. */
const DEFAULT_MAX_RUN_MS = 24 * 60 * 60 * 1_000

/**
 * Poll for messages until stopped, aborted, or the run limit is reached.
 * @param options - the poll, the handlers, and the policy.
 * @returns when the loop has finished.
 */
export async function monitorLoop(options: MonitorOptions): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const deadline = now() + (options.maxRunMs ?? DEFAULT_MAX_RUN_MS)

  let cursor = options.initialCursor
  let pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS

  while (!options.shouldStop() && !(options.signal?.aborted ?? false) && now() < deadline) {
    let response: MonitorResponse
    try {
      // Race the poll against the abort: a long poll holds for up to 35
      // seconds, and a stop that waited it out would look hung. The poll's own
      // rejection is left to settle on its own rather than becoming an
      // unhandled rejection.
      const polled = options.poll(cursor, pollTimeoutMs)
      response = options.signal === undefined
        ? await polled
        : await Promise.race([polled, abortPromise(options.signal)])
    } catch (error) {
      // A long poll routinely fails at the transport level - a gateway timeout,
      // a client-side abort. Treating it as channel failure would disconnect a
      // user who is mid-scan.
      if (options.signal?.aborted ?? false) break
      void error
      await sleep(IDLE_INTERVAL_MS)
      continue
    }

    if (options.signal?.aborted ?? false) break

    // The cursor addresses messages, not polls, so it advances only on a
    // response that actually carried one. An empty value means "no change".
    const nextCursor = response.get_updates_buf
    if (typeof nextCursor === 'string' && nextCursor !== '') {
      cursor = nextCursor
      await options.saveCursor(nextCursor)
    }

    if (typeof response.longpolling_timeout_ms === 'number' && response.longpolling_timeout_ms > 0) {
      pollTimeoutMs = response.longpolling_timeout_ms
    }

    const messages = response.msgs ?? []
    if (messages.length === 0) {
      await sleep(IDLE_INTERVAL_MS)
      continue
    }

    for (const message of messages) {
      const work = async (): Promise<void> => {
        try {
          await options.onMessage(message)
        } catch (error) {
          // One bad message must not take the channel down; the failure is
          // reported and the loop keeps polling.
          options.onMessageError?.(error, message)
        }
      }
      // Detached by design: awaiting here would make the poll wait for the
      // turn, which is exactly the coupling Q36 removed. `serialize` is how the
      // peer's queue is applied, and it resolves only after that peer's earlier
      // work, so its result must not be awaited either.
      // The result is deliberately dropped: awaiting it would reintroduce the
      // coupling Q36 removed. A rejection cannot escape, because `work` catches
      // its own failures and reports them through `onMessageError`.
      void (options.serialize === undefined ? work() : options.serialize(message, work))
    }
    // Let the handlers start before the next poll, so a stop request issued
    // from one is seen on the next iteration rather than after a full poll.
    await Promise.resolve()
  }

  // Handlers started here are not awaited: one may be waiting on something the
  // caller only releases after this function returns, and waiting would
  // deadlock exactly the decoupling Q36 asked for. Their outcome is reported
  // through `onMessageError`, not through this function's completion.
}

/** Resolve as soon as the signal aborts, so a held poll cannot delay a stop. */
function abortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(new Error('aborted'))
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
}

export { IDLE_INTERVAL_MS }
