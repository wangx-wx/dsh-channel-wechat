/**
 * Reading the files the agent declared as deliverables.
 *
 * DSH gives a channel no way to hand a file to a user, so the only first-class
 * signal is the durable `deliverables/presented` event the `present` tool
 * appends. This module is that event's reader, and it is deliberately strict:
 *
 * **"produced a file" and "this file is for you" are different things.** An agent
 * writing a report also writes scratch scripts and intermediate data; sending all
 * of it would bury the deliverable. `present` is the model's own declaration that
 * a file is finished and wanted, so this module reads exactly that and nothing
 * else - no path scanning, no guessing.
 *
 * A malformed entry is skipped rather than fatal, because losing the user's real
 * files to one bad one is the worse outcome.
 *
 * @module dsh-channel-wechat/bridge/deliverables
 */

/** One file the agent declared as a deliverable. */
export interface PresentedFile {
  /** An absolute path, resolved against the session's working directory. */
  path: string
  /** The model's own description of the file, when it gave one. */
  description?: string
}

/** The event name the `present` tool appends under. */
const PRESENTED_EVENT = 'deliverables/presented'

/**
 * Read the presented files from one committed session event.
 *
 * @param event - the session event, as `session/event` delivers it.
 * @param cwd - the session's working directory, used to resolve a relative path.
 * @returns the declared files, or `undefined` when this is not a present event
 *   or carries nothing usable.
 */
export function presentedFilesFrom(event: unknown, cwd: string): PresentedFile[] | undefined {
  if (event === null || typeof event !== 'object') return undefined
  const typed = event as { type?: unknown; data?: unknown }
  if (typed.type !== PRESENTED_EVENT) return undefined
  if (typed.data === null || typeof typed.data !== 'object') return undefined
  const entries = (typed.data as { files?: unknown }).files
  if (!Array.isArray(entries)) return undefined

  const files: PresentedFile[] = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const path = (entry as { path?: unknown }).path
    // A path is the one field that must be there; without it there is nothing
    // to send, so the entry is skipped rather than filled in.
    if (typeof path !== 'string' || path.trim() === '') continue
    const description = (entry as { description?: unknown }).description
    files.push({
      // The tool documents a relative path as relative to the Session cwd, and
      // this process has a different one - so resolving here is what makes the
      // path mean what the model meant.
      path: resolvePath(path.trim(), cwd),
      ...(typeof description !== 'string' || description.trim() === ''
        ? {}
        : { description: description.trim() }),
    })
  }
  return files.length === 0 ? undefined : files
}

/**
 * Whether `path` names one fixed location, in either spelling a Session records.
 *
 * A session's cwd is on whichever platform the Host runs, so this process may be
 * reading a Windows path on POSIX or the reverse. The rule is the Host's own
 * (`dsh-util-workspace-path`'s `isAbsoluteWorkspacePath`): POSIX-absolute, a
 * drive-qualified Windows path, or a complete UNC share. A drive-relative path
 * (`D:x`) is not absolute - it resolves against that drive's current directory.
 *
 * @param path - the path to classify.
 * @returns whether it is already absolute.
 */
function isAbsolutePath(path: string): boolean {
  if (path.startsWith('/')) return true
  if (/^[A-Za-z]:[\\/]/.test(path)) return true
  return /^\\\\[^\\/]+[\\/][^\\/]+/.test(path)
}

/**
 * Resolve a session-relative path, leaving an absolute one alone.
 *
 * The separator follows the cwd's own spelling rather than always `/`: a
 * Windows cwd joined with `/` would produce `D:\ws/out/report.xlsx`, which the
 * Windows APIs tolerate but which is not the path anyone wrote.
 *
 * @param path - the declared path, as the model wrote it.
 * @param cwd - the Session's working directory.
 * @returns the absolute path.
 */
function resolvePath(path: string, cwd: string): string {
  if (isAbsolutePath(path)) return path
  const separator = cwd.includes('\\') ? '\\' : '/'
  return cwd.endsWith('/') || cwd.endsWith('\\') ? `${cwd}${path}` : `${cwd}${separator}${path}`
}
