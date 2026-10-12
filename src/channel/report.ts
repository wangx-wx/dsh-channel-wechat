/**
 * Where a channel's problems are reported.
 *
 * The channel's own messages went to `ctx.logger`, and no profile mounts a
 * console exporter for the named logger. So every diagnostic this plugin wrote
 * was invisible: a failed inbound message, a failed reply, a rejected credential
 * write. Two live defects were found only after temporarily replacing those calls
 * with `console.error`, and one of them - every restart dropping every message -
 * had been reported to a log nobody could read.
 *
 * So a report goes to both: `console` is what a person running `dsh` can see, and
 * the logger is what a GUI or an operator's sink can collect.
 *
 * @module dsh-channel-wechat/channel/report
 */

/** A logger with the one level this module uses. */
export interface LoggerLike {
  warn: (format: string, ...args: unknown[]) => void
}

/** What a report needs. */
export interface ReporterOptions {
  /** The named logger, which a GUI may export and a bare CLI does not. */
  logger: LoggerLike
  /** Sink for the human-readable line; defaults to `console.error`. */
  write?: (line: string) => void
}

/** Report one problem. */
export type Report = (label: string, detail: unknown) => void

/**
 * Build a reporter that reaches both sinks.
 * @param options - the logger and an optional console replacement.
 * @returns the reporter the channel calls.
 */
export function createReporter(options: ReporterOptions): Report {
  const write = options.write ?? ((line: string) => { console.error(line) })
  return (label, detail) => {
    const text = detail instanceof Error ? detail.message : String(detail)
    // The logger first: it is the structured channel, and a sink may format the
    // detail differently from the line a terminal gets.
    options.logger.warn('%s: %s', label, text)
    write(`[channel-wechat] ${label}: ${text}`)
  }
}
