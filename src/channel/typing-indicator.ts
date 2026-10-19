/**
 * The typing indicator during one turn.
 *
 * The protocol's indicator expires, so a turn that runs for a minute needs more
 * than one report: the reference implementation renews every five seconds and
 * this follows it. The lifecycle is the channel's own turn boundary - show it
 * after the message is accepted, withdraw it when the turn settles, including
 * when the turn fails.
 *
 * Every failure here is silent by design. The indicator is decoration, and a
 * turn that refused to run because its indicator could not be shown would trade
 * the useful part for the decoration. The one failure worth acting on is a
 * rejected status report: it is the only evidence a cached ticket went stale,
 * so it invalidates that ticket and stops renewing.
 *
 * @module dsh-channel-wechat/channel/typing-indicator
 */

/** What one channel turn does with the indicator. */
export interface TypingIndicator {
  /** Begin showing the indicator; resolves once the first report was attempted. */
  start: (userId: string) => Promise<void>
  /** Withdraw it and stop renewing. Never rejects. */
  stop: (userId: string) => Promise<void>
}

/** Collaborators and policy for {@link createTypingIndicator}. */
export interface TypingIndicatorOptions {
  /** Fetch a user's ticket; an empty string means none is available. */
  ticket: (userId: string) => Promise<string>
  /** Report one status. Rejects when the server refused it. */
  report: (params: { userId: string; ticket: string; status: number }) => Promise<void>
  /** Forget a ticket the server rejected. */
  invalidate: (userId: string) => void
  /** Renewal interval; defaults to five seconds, as the reference client does. */
  intervalMs?: number
  /**
   * Schedules a renewal; replaced in tests.
   *
   * The work may be asynchronous, and a replacement scheduler may return it so
   * a test can await one tick instead of guessing at microtask ordering.
   */
  schedule?: (work: () => void | Promise<void>, ms: number) => ReturnType<typeof setInterval>
  /** Cancels a renewal; replaced alongside {@link schedule}. */
  cancelSchedule?: (handle: ReturnType<typeof setInterval>) => void
  /** Observe a failure, for diagnostics. */
  onError?: (error: unknown, userId: string) => void
}

/** The protocol's two status values, repeated here so this module stands alone. */
const TYPING = 1
const CANCEL = 2

/** The reference client's renewal interval. */
const DEFAULT_INTERVAL_MS = 5_000

/** One user's live indicator. */
interface Active {
  /** The ticket the indicator was started with. */
  ticket: string
  /** The renewal timer, while one is running. */
  timer: ReturnType<typeof setInterval> | undefined
}

/**
 * Build the indicator used by the channel's turns.
 * @param options - the ticket cache and the wire.
 * @returns the two lifecycle calls a turn makes.
 */
export function createTypingIndicator(options: TypingIndicatorOptions): TypingIndicator {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const schedule = options.schedule ?? ((work, ms) => setInterval(work, ms))
  const cancel = options.cancelSchedule ?? (handle => { clearInterval(handle) })
  const active = new Map<string, Active>()

  /** Report one status, reporting rather than throwing a failure. */
  const report = async (userId: string, ticket: string, status: number): Promise<boolean> => {
    try {
      await options.report({ userId, ticket, status })
      return true
    } catch (error: unknown) {
      options.onError?.(error, userId)
      return false
    }
  }

  return {
    async start(userId: string): Promise<void> {
      // A second turn for the same user replaces the first one's indicator
      // rather than stacking timers: the status is per user, so two renewals
      // would only race each other.
      const previous = active.get(userId)
      if (previous?.timer !== undefined) cancel(previous.timer)

      let ticket = ''
      try {
        ticket = await options.ticket(userId)
      } catch {
        // The cache already answers an empty string for its own failures; this
        // covers a replacement that throws.
        ticket = ''
      }
      // No ticket means no indicator. Not an error: the channel keeps working.
      if (ticket === '') {
        active.delete(userId)
        return
      }
      if (!await report(userId, ticket, TYPING)) {
        // The first report was refused, so the ticket is stale. Drop it and
        // leave the indicator off rather than renewing a value known to fail.
        options.invalidate(userId)
        active.delete(userId)
        return
      }

      const renew = async (): Promise<void> => {
        const current = active.get(userId)
        // The turn may have ended between the tick and this callback.
        if (current === undefined) return
        if (await report(userId, current.ticket, TYPING)) return
        // A rejected renewal means the ticket lapsed mid-turn. Stop renewing
        // rather than retrying a value the server already refused.
        if (current.timer !== undefined) cancel(current.timer)
        active.delete(userId)
        options.invalidate(userId)
      }
      const timer = schedule(renew, intervalMs)
      // A renewal must not be the thing holding the process open during a
      // shutdown that already released every session.
      timer.unref?.()
      active.set(userId, { ticket, timer })
    },

    async stop(userId: string): Promise<void> {
      const current = active.get(userId)
      // Nothing to withdraw: either the indicator never started or a rejected
      // renewal already retired it.
      if (current === undefined) return
      active.delete(userId)
      if (current.timer !== undefined) cancel(current.timer)
      // Best effort: a failure here leaves an indicator that expires on its
      // own, which is worse to look at but not worth reporting as an error.
      await report(userId, current.ticket, CANCEL)
    },
  }
}
