/**
 * Reading `deliverables/presented` out of a session event.
 *
 * The `present` tool declares files as final deliverables, and this is what turns
 * that declaration into something sendable. Two decisions matter:
 *
 *  - **Only a successful present counts.** The tool resolves its paths and
 *    appends the event from `tools/result`, so the event's presence already means
 *    the files existed at that moment.
 *  - **A relative path is relative to the session's cwd**, not to the plugin's
 *    process, so it has to be resolved before anything reads it.
 */

import { describe, expect, it } from 'vitest'
import { presentedFilesFrom } from '../../src/bridge/deliverables.ts'

/** One committed session event. */
function event(type: string, data: unknown) {
  return { type, data }
}

describe('reading a presented-file event', () => {
  it('reads the paths the agent declared', () => {
    const files = presentedFilesFrom(
      event('deliverables/presented', {
        turn: 3,
        callId: 'c1',
        files: [{ path: '/w/report.xlsx', description: '月度报表' }],
      }),
      '/w',
    )

    expect(files).toEqual([{ path: '/w/report.xlsx', description: '月度报表' }])
  })

  it('resolves a relative path against the session working directory', () => {
    // The tool documents relative paths as relative to the Session cwd, and a
    // plugin process has a different cwd - so reading the raw value would look
    // for the file in the wrong place.
    const files = presentedFilesFrom(
      event('deliverables/presented', { turn: 1, callId: 'c1', files: [{ path: 'out/report.xlsx' }] }),
      '/work/here',
    )

    expect(files?.[0]?.path).toBe('/work/here/out/report.xlsx')
  })

  it('leaves an absolute Windows path alone', () => {
    // A drive-qualified path is already absolute, so resolving it against the
    // cwd would produce `D:\ws\D:\ws\out\report.xlsx` - a path that exists
    // nowhere. This suite runs on macOS, where `path.win32` still classifies the
    // spelling correctly, so the case is testable off Windows.
    const files = presentedFilesFrom(
      event('deliverables/presented', { turn: 1, callId: 'c1', files: [{ path: 'D:\\ws\\out\\report.xlsx' }] }),
      'D:\\ws',
    )

    expect(files?.[0]?.path).toBe('D:\\ws\\out\\report.xlsx')
  })

  it('joins a relative path with the separator its cwd already uses', () => {
    // A Windows cwd joined with `/` produces `D:\ws/report.xlsx`. Windows APIs
    // tolerate that, but the result is then not the path anyone wrote, and it is
    // handed to a file read. Only the JOIN uses the cwd's separator; separators
    // inside the model's own relative path are left as written.
    const files = presentedFilesFrom(
      event('deliverables/presented', { turn: 1, callId: 'c1', files: [{ path: 'report.xlsx' }] }),
      'D:\\ws',
    )

    expect(files?.[0]?.path).toBe('D:\\ws\\report.xlsx')
  })

  it('does not double the separator when the cwd already ends with one', () => {
    // A drive root (`D:\`) ends in a separator, and appending another would name
    // a path that does not exist.
    const files = presentedFilesFrom(
      event('deliverables/presented', { turn: 1, callId: 'c1', files: [{ path: 'report.xlsx' }] }),
      'D:\\',
    )

    expect(files?.[0]?.path).toBe('D:\\report.xlsx')
  })

  it('ignores every other kind of session event', () => {
    // This runs on every append for every session, so returning anything for an
    // unrelated event would send files nobody declared.
    expect(presentedFilesFrom(event('assistant/message', { text: 'hi' }), '/w')).toBeUndefined()
    expect(presentedFilesFrom(event('turn/end', {}), '/w')).toBeUndefined()
  })

  it('ignores a files-like payload on an event that is not a present', () => {
    // The discriminating case, and the one a real neighbour nearly provided:
    // `workspace/changes` describes every file the turn TOUCHED - scratch
    // scripts and intermediate data included. It happens to keep its file list
    // in a projection rather than in the event, so the name is the ONLY thing
    // separating "the model declared this for you" from "this file changed".
    // Sending the latter would bury the deliverable in the agent's leftovers.
    const files = [{ path: '/w/scratch.tmp' }, { path: '/w/build.log' }]

    expect(presentedFilesFrom(event('workspace/changes', { turn: 1, files }), '/w')).toBeUndefined()
    expect(presentedFilesFrom(event('deliverables/presented', { turn: 1, files }), '/w')).toHaveLength(2)
  })

  it('ignores a malformed event rather than inventing paths', () => {
    // The event crosses a durable log boundary, so a shape that does not match
    // is possible and must not produce a guessed path.
    expect(presentedFilesFrom(event('deliverables/presented', {}), '/w')).toBeUndefined()
    expect(presentedFilesFrom(event('deliverables/presented', { files: 'nope' }), '/w')).toBeUndefined()
    expect(presentedFilesFrom(event('deliverables/presented', { files: [{}] }), '/w')).toBeUndefined()
    expect(presentedFilesFrom(event('deliverables/presented', { files: [{ path: '  ' }] }), '/w')).toBeUndefined()
  })

  it('keeps the good entries when one is malformed', () => {
    // A single bad entry must not cost the user the files that are fine.
    const files = presentedFilesFrom(
      event('deliverables/presented', { files: [{ path: 'a.txt' }, {}, { path: 'b.txt' }] }),
      '/w',
    )

    expect(files?.map(file => file.path)).toEqual(['/w/a.txt', '/w/b.txt'])
  })

  it('reads an already-absolute path unchanged', () => {
    const files = presentedFilesFrom(
      event('deliverables/presented', { files: [{ path: '/abs/x.pdf' }] }),
      '/w',
    )

    expect(files?.[0]?.path).toBe('/abs/x.pdf')
  })

  it('drops an empty description rather than carrying an empty string', () => {
    // The description is shown to the user; an empty one is noise, and carrying
    // it would put a blank line in the message.
    const files = presentedFilesFrom(
      event('deliverables/presented', { files: [{ path: 'a.txt', description: '   ' }] }),
      '/w',
    )

    expect(files).toEqual([{ path: '/w/a.txt' }])
  })
})
