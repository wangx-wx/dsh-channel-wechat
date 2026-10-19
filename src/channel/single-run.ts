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
   * @returns when the run has been launched, not when it finishes. A `force`
   *   replaces only after the previous run's teardown has completed.
   */
  start: (options?: { force?: boolean }) => Promise<void>
  /** Whether a run is currently live. */
  live: () => boolean
  /**
   * End the live run, if there is one.
   * @returns when the run's own teardown has finished, not merely when it was
   *   told to stop.
   */
  stop: () => Promise<void>
}

/** What a run needs from its owner. */
export interface SingleRunOptions {
  /**
   * Launch the run.
   * @param signal - aborted when this run is replaced or stopped.
   * @returns a promise for the run's own lifetime, so a stop can wait for its
   *   teardown instead of racing it. Absent for callers that cannot report it.
   */
  launch: (signal: AbortSignal) => void | Promise<void>
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
  /**
   * The live run's own settlement.
   *
   * Kept beside the controller because aborting is not stopping: the loop still
   * has to notice the signal, drain its queue and release every session it
   * owns. A replacement that started on the abort alone would overlap the run
   * it replaced - two loops over one account, two writers of one cursor, and a
   * session created by one whose handle only the other can see.
   */
  let settled: Promise<void> | undefined

  return {
    async start({ force = false } = {}): Promise<void> {
      if (current !== undefined) {
        // Refusing is the default because two loops over one account duplicate
        // every message; replacing is opt-in because only the caller knows
        // whether it is connecting an account the live run never saw.
        if (!force) return
        await this.stop()
      }
      const controller = new AbortController()
      current = controller
      try {
        const launched = options.launch(controller.signal)
        settled = launched === undefined
          ? undefined
          : Promise.resolve(launched)
            .catch((error: unknown) => { options.onError?.(error) })
            .then(() => {
              // The loop can finish without anyone stopping it - the run limit,
              // a poll that gave up. Releasing the slot here is what keeps
              // `live()` honest and lets a later start launch again; without it
              // the finished run blocked every replacement by name alone.
              //
              // Guarded by identity: a forced replacement or a stop has already
              // cleared `current`, and this must not clear the run that replaced
              // it.
              if (current === controller) {
                current = undefined
                settled = undefined
              }
            })
      } catch (error) {
        // A launch that throws must not leave the run marked live, or no later
        // start could ever succeed.
        if (current === controller) { current = undefined; settled = undefined }
        options.onError?.(error)
      }
    },

    live(): boolean {
      return current !== undefined
    },

    async stop(): Promise<void> {
      current?.abort()
      current = undefined
      // Awaited rather than fired and forgotten: the caller is usually about to
      // start its replacement, and an overlap is the defect this type exists to
      // prevent.
      const running = settled
      settled = undefined
      await running
    },
  }
}
