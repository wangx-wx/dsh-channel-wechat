/**
 * The configuration fields the GUI can edit.
 *
 * `@deepseek-ai/dsh-settings` projects a plugin's Config schema into a form, and
 * it does so by walking for `schema.meta.volatile`:
 *
 *   volatileForm(schema)  // packages/settings/settings/src/schema.ts
 *   if (schema.meta.volatile) return plainSchema(schema)
 *
 * A field without that flag is **absent** from the projection, not read-only:
 * `projectForm` then strips it from the value the client receives, and a write
 * to it is refused with `Config field "x" is not volatile`. An entry with no
 * volatile field at all does not appear in `describe()`.
 *
 * So the flag is the whole difference between "editable in the GUI" and "invisible
 * in the GUI", and it fails silently in the worst direction - the page renders,
 * the form simply has no field in it. This suite pins the flag itself, which is
 * what the form is derived from; the page's own wiring is covered by the boot
 * suites.
 */

import { describe, expect, it } from 'vitest'
import { Config } from '../../src/index.ts'

/** The schema node for one top-level field. */
function field(name: string) {
  return (Config as unknown as { dict: Record<string, { meta: { volatile?: boolean; required?: boolean; default?: unknown } }> })
    .dict[name]
}

describe('the fields the GUI form is built from', () => {
  it('marks every editable field volatile', () => {
    // Both are on the page. Dropping either flag removes that field from the
    // form with no error anywhere.
    expect(field('cwd')?.meta.volatile).toBe(true)
    expect(field('cards')?.meta.volatile).toBe(true)
  })

  it('keeps `cwd` required and defaultless', () => {
    // Required on purpose: a session's working directory is immutable once
    // recorded, and the web app's system prompt reads it through `{{cwd}}`. A
    // missing value fails the turn before the provider is called, so a silent
    // default would record a directory the operator never chose into sessions
    // that can never be moved.
    expect(field('cwd')?.meta.required).toBe(true)
    expect(field('cwd')?.meta.default).toBeUndefined()
  })

  it('gives `cards` a default so an older profile still loads', () => {
    // A profile written before this key existed has to keep booting, which is
    // why the field is defaulted rather than required.
    expect(field('cards')?.meta.default).toBe('wechat')
  })
})
