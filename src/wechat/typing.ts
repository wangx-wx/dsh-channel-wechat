/**
 * The typing indicator: a per-user ticket, and a status that has to be renewed.
 *
 * WeChat has no push channel for this. The bot asks `getConfig` for a ticket
 * bound to one user, then reports `status: 1` while it works and `2` when it
 * stops. Two consequences shape this module:
 *
 *  - **The ticket is per user, not per conversation.** `ilink_user_id` names a
 *    person, so one ticket cannot serve another.
 *  - **The indicator expires.** The reference implementation renews it every
 *    five seconds, which is the strongest available evidence that a single
 *    report does not persist.
 *
 * Everything here degrades to "no indicator". The indicator is decoration; a
 * reply that waited on a ticket fetch would trade the useful part for it. That
 * is also why a failure is remembered with a backoff rather than retried on
 * every message: an endpoint that is down must not turn into a burst of
 * failing requests.
 *
 * @module dsh-channel-wechat/wechat/typing
 */

/** The two status values `sendtyping` accepts. */
export const TypingStatus = {
  /** Show the indicator. */
  TYPING: 1,
  /** Withdraw it, which is what stops one that outlived its turn. */
  CANCEL: 2,
} as const

/** One user's cached ticket and when it stops being usable. */
interface TicketEntry {
  /** The ticket, or an empty string when the fetch failed. */
  ticket: string
  /** Monotonic milliseconds after which this entry must be refetched. */
  expiresAt: number
}

/** Collaborators and policy for {@link TypingTicketCache}. */
export interface TypingTicketCacheOptions {
  /**
   * Fetch one user's ticket; an empty string means the server declined.
   *
   * A rejection is treated the same as an empty answer - both mean "no
   * indicator this time" - but they are cached differently: a declined ticket
   * is retried on the normal TTL, a failed fetch on the backoff.
   */
  getConfig: (params: { userId: string; contextToken: string | undefined }) => Promise<string>
  /** How long a ticket is trusted; defaults to 24 hours. */
  ttlMs?: number
  /** How long a failed fetch is remembered before retrying; defaults to 2 seconds. */
  retryBackoffMs?: number
  /** Monotonic milliseconds; replaced in tests. */
  now?: () => number
}

/** A default ticket lifetime: the reference implementation's own outer bound. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000

/** A default backoff after a fetch failure. */
const DEFAULT_RETRY_BACKOFF_MS = 2_000

/**
 * Tickets for each user, kept in memory only.
 *
 * Not persisted: a ticket is cheap to fetch once per user per run, and a stale
 * one restored from disk would fail every status report until its deadline.
 */
export class TypingTicketCache {
  private readonly entries = new Map<string, TicketEntry>()
  private readonly getConfig: TypingTicketCacheOptions['getConfig']
  private readonly ttlMs: number
  private readonly retryBackoffMs: number
  private readonly now: () => number

  /**
   * @param options - the fetch, the TTL, and the clock.
   */
  constructor(options: TypingTicketCacheOptions) {
    this.getConfig = options.getConfig
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS
    this.now = options.now ?? Date.now
  }

  /**
   * The ticket for one user, fetching it when the cache cannot answer.
   *
   * @param userId - the `ilink_user_id` the ticket is bound to.
   * @param contextToken - the conversation's token, when there is one.
   * @returns the ticket, or an empty string when none could be had.
   */
  async ticket(userId: string, contextToken?: string): Promise<string> {
    const cached = this.entries.get(userId)
    if (cached !== undefined && this.now() < cached.expiresAt) return cached.ticket

    let ticket = ''
    let lifetime = this.ttlMs
    try {
      ticket = await this.getConfig({ userId, contextToken })
    } catch {
      // Remembered, not thrown: the next message inside the backoff reuses this
      // answer instead of asking again.
      lifetime = this.retryBackoffMs
    }
    this.entries.set(userId, { ticket, expiresAt: this.now() + lifetime })
    return ticket
  }

  /**
   * Forget one user's ticket, so the next call fetches a fresh one.
   *
   * Called when a status report is rejected: that is the only evidence a ticket
   * went stale before its deadline, and without this the cache would keep
   * handing out the rejected value until the TTL ran out.
   *
   * @param userId - the user whose ticket is no longer trusted.
   */
  invalidate(userId: string): void {
    this.entries.delete(userId)
  }
}
