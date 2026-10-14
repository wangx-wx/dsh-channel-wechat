/**
 * Where a channel's diagnostics survive.
 *
 * A report already reaches `console` and the named logger, which is enough on a
 * terminal. It is not enough on the desktop app: the host's stdout is piped to
 * the Electron main process, which has no terminal and writes no log file, so a
 * report reaches nothing that outlives the session - and a problem that only
 * happens at night leaves no trace at all.
 *
 * So a report also appends here, split by local date and pruned after a week.
 *
 * The sink never throws. A report is written because something already went
 * wrong, and failing to record that must not become the larger failure.
 *
 * @module dsh-channel-wechat/channel/log-file
 */

import { mkdirSync, readdirSync, rmSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** How many daily files to keep, including today's. */
export const RETAIN_DAYS = 7

/** The directory this plugin owns, under the harness home. */
const STATE_DIRNAME = 'channel-wechat'

/** The subdirectory the logs live in, so state and diagnostics stay apart. */
const LOG_DIRNAME = 'log'

/**
 * The directory the log files live in.
 *
 * Under the plugin's own state directory rather than beside the sessions: this is
 * channel state, and it belongs with the cursor and the peer generations. A
 * subdirectory keeps it from being mistaken for one of the small JSON documents
 * that state directory otherwise holds.
 * @returns the absolute log directory; it is created on the first write.
 */
export function logDirPath(): string {
  return join(resolveDshHome(), STATE_DIRNAME, LOG_DIRNAME)
}

/** The prefix every file this sink owns carries. */
const FILE_PREFIX = 'channel-wechat-'

/** The suffix every file this sink owns carries. */
const FILE_SUFFIX = '.log'

/**
 * The file a line written at `when` belongs in.
 *
 * Built from local date components rather than `toISOString`, which would roll
 * over at UTC midnight and file an evening report under tomorrow for anyone west
 * of Greenwich.
 * @param when - the moment the line was written.
 * @returns the file name, not a path.
 */
export function logFileName(when: Date): string {
  const year = when.getFullYear()
  const month = String(when.getMonth() + 1).padStart(2, '0')
  const day = String(when.getDate()).padStart(2, '0')
  return `${FILE_PREFIX}${year}-${month}-${day}${FILE_SUFFIX}`
}

/** What the sink needs. */
export interface LogFileSinkOptions {
  /** The directory this plugin owns; created on first write. */
  dir: string
  /** The clock; tests move it to cross a day boundary without waiting. */
  now?: () => Date
  /** How many daily files to keep; defaults to {@link RETAIN_DAYS}. */
  retainDays?: number
  /** Observes a write failure, which is otherwise swallowed. */
  onError?: (error: unknown) => void
}

/** Append one already-formatted line to today's file. */
export type WriteLogLine = (line: string) => void

/**
 * Build the file sink.
 *
 * Pruning runs on the first write of each new day rather than on a timer: the
 * process may not live long enough for an interval to fire, and a sweep tied to
 * writing cannot fall behind by more than the time nobody was running.
 * @param options - the directory, clock, retention, and error observer.
 * @returns the sink the reporter calls.
 */
export function createLogFileSink(options: LogFileSinkOptions): WriteLogLine {
  const now = options.now ?? (() => new Date())
  const retainDays = options.retainDays ?? RETAIN_DAYS
  let prepared: string | undefined

  /** Create the directory and drop files past the retention window. */
  const prepare = (today: string): void => {
    mkdirSync(options.dir, { recursive: true })
    const keep = new Set<string>()
    for (let offset = 0; offset < retainDays; offset++) {
      const day = new Date(now().getTime())
      day.setDate(day.getDate() - offset)
      keep.add(logFileName(day))
    }
    keep.add(today)
    for (const entry of readdirSync(options.dir)) {
      if (!entry.startsWith(FILE_PREFIX) || !entry.endsWith(FILE_SUFFIX)) continue
      if (keep.has(entry)) continue
      rmSync(join(options.dir, entry), { force: true })
    }
  }

  return line => {
    try {
      const name = logFileName(now())
      if (prepared !== name) {
        prepare(name)
        prepared = name
      }
      appendFileSync(join(options.dir, name), line, { mode: 0o600 })
    } catch (error: unknown) {
      // The cache is dropped as well as the error reported. `prepared` claims the
      // directory exists and the window is pruned; after a failure that claim is
      // exactly what is no longer known to be true. Keeping it would let one bad
      // write - a directory that briefly vanished, a disk that was full - silence
      // this sink for the rest of the process lifetime.
      prepared = undefined
      // Losing a log line is never worth taking the channel down for. The error
      // goes to the observer, which is the console on a terminal, so a failed
      // write is still visible to whoever is watching.
      options.onError?.(error)
    }
  }
}
