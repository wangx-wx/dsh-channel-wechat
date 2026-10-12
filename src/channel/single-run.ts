/**
 * One polling run at a time.
 *
 * Two independent paths start the channel: the boot, which reads whatever login
 * is stored, and the login panel, which connects an account that was not there
 * when the boot ran. Left alone they overlap, and two loops polling the same
 * account deliver every message twice.
 *
 * So a run is owned here. A second start while one is live is refused, and the
 * case that legitimately needs a new run - the panel connecting an account -
 * aborts the old one first instead of racing it.
 *
 * @module dsh-channel-wechat/channel/single-run
 */

/** A run's lifecycle. */
export interface SingleRun {
  /**
   * Start a run, or refuse when one is already live.
   * @param options - `force` ends the live run and replaces it.
   * @returns when the run has been launched, not when it finishes.
   */
  start: (options?: { force?: boolean }) => void
  /** Whether a run is currently live. */
  live: () => boolean
  /** End the live run, if there is one. */
  stop: () => void
}

/** What a run needs from its owner. */
export interface SingleRunOptions {
  /**
   * Launch the run.
   * @param signal - aborted when this run is replaced or stopped.
   */
  launch: (signal: AbortSignal) => void
  /** Observe a launch failure, which must not end the whole plugin. */
  onError?: (error: unknown) => void
}

/**
 * Own one run at a time.
 * @param options - the launch callback and its error sink.
 * @returns the run's lifecycle.
 */
export function createSingleRun(options: SingleRunOptions): SingleRun {
  let current: AbortController | undefined

  return {
    start({ force = false } = {}): void {
      if (current !== undefined) {
        // Refusing is the default because two loops over one account duplicate
        // every message; replacing is opt-in because only the caller knows
        // whether it is connecting an account the live run never saw.
        if (!force) return
        current.abort()
      }
      const controller = new AbortController()
      current = controller
      try {
        options.launch(controller.signal)
      } catch (error) {
        // A launch that throws must not leave the run marked live, or no later
        // start could ever succeed.
        if (current === controller) current = undefined
        options.onError?.(error)
      }
    },

    live(): boolean {
      return current !== undefined
    },

    stop(): void {
      current?.abort()
      current = undefined
    },
  }
}
