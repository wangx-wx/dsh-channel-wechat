/**
 * Waiting for work that may never finish.
 *
 * One use, and it is the one that matters: shutdown. A turn can be stuck in a
 * tool with no timeout or a provider call that never answers, and an unbounded
 * wait puts the host's shutdown behind it - on the desktop host that means the
 * process has to be killed.
 *
 * It lives in its own module because the rule it encodes is easy to get subtly
 * wrong and worth reading on its own: **the wait is bounded, the work is not
 * cancelled.** This only stops waiting; whatever is still running keeps running
 * until the process exits.
 *
 * @module dsh-channel-wechat/channel/settle
 */

/**
 * How long shutdown waits for in-flight turns by default.
 *
 * Long enough for a reply that is merely slow to be flushed - the whole reason
 * the wait exists - and short enough that a turn stuck in a hung tool cannot
 * hold the host's shutdown open. The reply such a turn would have produced is
 * lost either way; the difference is whether the process exits.
 */
export const DEFAULT_TURN_SETTLE_TIMEOUT_MS = 10_000

/**
 * Wait for `work` to settle, but not past `timeoutMs`.
 *
 * The timer is unref'd for the same reason the reply queue's sleeps are: this
 * runs during shutdown, and a pending timer is the one thing that can keep the
 * process alive after everything else has stopped.
 * @param work - the promises to wait for.
 * @param timeoutMs - the longest to wait.
 * @returns true when all of them settled in time.
 */
export async function settleWithin(work: readonly Promise<unknown>[], timeoutMs: number): Promise<boolean> {
  if (work.length === 0) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs)
    timer.unref()
  })
  try {
    return await Promise.race([
      Promise.allSettled(work).then(() => true as const),
      bound,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
