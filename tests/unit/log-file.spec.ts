/**
 * Where a channel's diagnostics survive.
 *
 * The channel already writes a report to `console` and to the named logger. On a
 * terminal those are enough - that is how two live defects were found. On the
 * desktop app they are not: the host's stdout is piped to the Electron main
 * process, which has no terminal attached and writes no log file, so a report
 * reaches nothing that outlives the session. A problem that only happens at night
 * leaves no trace at all.
 *
 * So a report also appends to a file this plugin owns, split by local date and
 * pruned after a week. The sink must never take the channel down: a report is
 * written *because* something already went wrong, and failing to record that
 * cannot be allowed to become the larger failure.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLogFileSink, logFileName } from '../../src/channel/log-file.ts'

/** Every directory a test created, removed after it, pass or fail. */
const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A temporary directory for one test; nothing touches the developer's home. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wechat-log-'))
  created.push(dir)
  return dir
}

/** A clock the test moves by hand, so a day boundary is not a wait. */
function clock(start: Date) {
  let now = start
  return {
    now: () => now,
    set: (next: Date) => { now = next },
  }
}

describe('the diagnostic log file', () => {
  it('appends a line to a file named for the local date', () => {
    const dir = tempDir()
    const time = clock(new Date(2026, 9, 15, 13, 45, 30))

    createLogFileSink({ dir, now: time.now })('[channel-wechat] polling as: bot-9\n')

    const written = readFileSync(join(dir, 'channel-wechat-2026-10-15.log'), 'utf8')
    expect(written).toBe('[channel-wechat] polling as: bot-9\n')
  })

  it('starts a new file when the local date changes mid-run', () => {
    // A long-lived channel crosses midnight without restarting. Recomputing the
    // name only once - the obvious shape - would append tomorrow's lines to
    // yesterday's file and then prune them away as out of window.
    const dir = tempDir()
    const time = clock(new Date(2026, 9, 15, 23, 59, 0))
    const write = createLogFileSink({ dir, now: time.now })

    write('[channel-wechat] before midnight: a\n')
    time.set(new Date(2026, 9, 16, 0, 1, 0))
    write('[channel-wechat] after midnight: b\n')

    expect(readFileSync(join(dir, 'channel-wechat-2026-10-15.log'), 'utf8'))
      .toBe('[channel-wechat] before midnight: a\n')
    expect(readFileSync(join(dir, 'channel-wechat-2026-10-16.log'), 'utf8'))
      .toBe('[channel-wechat] after midnight: b\n')
  })

  it('keeps a week of daily files and deletes what falls out of the window', () => {
    // Seven days is a bound on disk usage, and the window has to be inclusive of
    // today: an off-by-one that keeps only six is invisible until someone needs
    // the seventh day, which is exactly when they need it.
    const dir = tempDir()
    const time = clock(new Date(2026, 9, 15, 12, 0, 0))
    // Days 10..15 exist on disk; day 8 is one past the window, day 9 is the edge.
    for (const day of [8, 9, 10, 11, 12, 13, 14, 15]) {
      writeFileSync(join(dir, `channel-wechat-2026-10-${String(day).padStart(2, '0')}.log`), 'old\n')
    }
    // A file this sink does not own must survive: a directory it shares with the
    // cursor and generation state is not a directory it may clean out.
    writeFileSync(join(dir, 'peer-sessions.json'), '{}\n')

    createLogFileSink({ dir, now: time.now })('[channel-wechat] today\n')

    const kept = readdirSync(dir).sort()
    expect(kept).toEqual([
      'channel-wechat-2026-10-09.log',
      'channel-wechat-2026-10-10.log',
      'channel-wechat-2026-10-11.log',
      'channel-wechat-2026-10-12.log',
      'channel-wechat-2026-10-13.log',
      'channel-wechat-2026-10-14.log',
      'channel-wechat-2026-10-15.log',
      'peer-sessions.json',
    ])
  })

  it('honours a retention window other than the default', () => {
    const dir = tempDir()
    const time = clock(new Date(2026, 9, 15, 12, 0, 0))
    for (const day of [12, 13, 14, 15]) {
      writeFileSync(join(dir, `channel-wechat-2026-10-${String(day).padStart(2, '0')}.log`), 'old\n')
    }

    createLogFileSink({ dir, now: time.now, retainDays: 2 })('[channel-wechat] today\n')

    expect(readdirSync(dir).sort()).toEqual([
      'channel-wechat-2026-10-14.log',
      'channel-wechat-2026-10-15.log',
    ])
  })

  it('reports a write failure instead of throwing at the caller', () => {
    // A report is written because something already went wrong. If a full disk
    // or a read-only directory could throw out of the reporter, the failure to
    // *record* a problem would become a larger problem than the one recorded -
    // and it would surface inside the error path, where nobody expects it.
    const time = clock(new Date(2026, 9, 15, 12, 0, 0))
    const seen: unknown[] = []
    // A regular file standing where the directory has to be: `mkdir` fails with
    // ENOTDIR, so every write attempt fails the same way.
    const blocker = join(tempDir(), 'not-a-directory')
    writeFileSync(blocker, 'in the way')
    const write = createLogFileSink({
      dir: join(blocker, 'log'),
      now: time.now,
      onError: error => { seen.push(error) },
    })

    expect(() => { write('[channel-wechat] boom\n') }).not.toThrow()
    expect(seen).toHaveLength(1)
  })

  it('keeps writing after a failed write, rather than latching the failure', () => {
    // The failure is per-write. A sink that gave up after the first error would
    // silently stop logging for the rest of the process lifetime - the same
    // "reported to a log nobody can read" shape this file exists to end.
    const dir = tempDir()
    const time = clock(new Date(2026, 9, 15, 12, 0, 0))
    const seen: unknown[] = []
    const write = createLogFileSink({ dir, now: time.now, onError: error => { seen.push(error) } })

    write('[channel-wechat] first\n')
    rmSync(dir, { recursive: true, force: true })
    writeFileSync(dir, 'a file where the directory was')

    write('[channel-wechat] blocked\n')
    rmSync(dir, { force: true })
    write('[channel-wechat] recovered\n')

    expect(readFileSync(join(dir, 'channel-wechat-2026-10-15.log'), 'utf8'))
      .toBe('[channel-wechat] recovered\n')
    expect(seen).toHaveLength(1)
  })

  it('formats the name from local components, not UTC', () => {
    // A name taken from `toISOString` would roll over at UTC midnight and file
    // an evening report under tomorrow for anyone west of Greenwich, and a
    // morning report under yesterday for anyone east of it.
    //
    // The expectation comes from `Intl`, not from `getFullYear` and friends: the
    // calendar date is read through a different code path, so this cannot pass
    // merely by repeating the implementation's arithmetic. It is also
    // timezone-independent - hand-written literals would only hold in UTC+8.
    const localDate = (when: Date): string =>
      new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(when)

    // Both edges of the local day: the trap is only visible away from midday.
    for (const when of [
      new Date(2026, 9, 15, 0, 15, 0),
      new Date(2026, 9, 15, 13, 45, 0),
      new Date(2026, 9, 15, 23, 30, 0),
    ]) {
      expect(logFileName(when)).toBe(`channel-wechat-${localDate(when)}.log`)
    }
  })
})
