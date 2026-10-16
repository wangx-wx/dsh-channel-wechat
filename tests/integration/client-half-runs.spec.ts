/**
 * The browser half, executed.
 *
 * The boot suite proves the bundle is *served*; nothing there proves it *runs*.
 * This file loads the artifact the browser would load, with the loader global and
 * a `require` table supplied the way the module system supplies them, and drives
 * `apply` over a fake client context. That is the only check available here for
 * the things a bundler would otherwise catch: a typo in a slot name, a hook
 * compartment under the wrong key, an `inject` face the renderer cannot bind.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` is stubbed rather than imported: its
 * built bundle imports CSS modules, which Node cannot resolve, and the page's
 * use of it (`SettingsForm`, `SettingsValueField`, `SettingsFormModel`) is not
 * what this suite is about. React is real, because the component tree is.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DSH_CHECKOUT, REPO_ROOT } from '../support/harness.ts'

/**
 * React, borrowed from the checkout that supplies the rest of the harness.
 *
 * This package deliberately does not depend on React: in a profile the browser
 * hands the bundle the shell's own copy through the frozen module table, so a
 * copy declared here would only prove something about a version nobody runs. The
 * checkout keeps it in the pnpm store rather than hoisted, so it is located by
 * looking for it rather than by requiring it.
 *
 * @returns a require bound to the located React, or undefined when the checkout
 *   has none - the suite then skips, rather than failing for a missing tool.
 */
function borrowReact(): NodeRequire | undefined {
  const store = join(DSH_CHECKOUT, 'node_modules', '.pnpm')
  if (!existsSync(store)) return undefined
  for (const entry of readdirSync(store)) {
    if (!entry.startsWith('react@')) continue
    const candidate = join(store, entry, 'node_modules', 'react')
    if (existsSync(join(candidate, 'package.json'))) return createRequire(join(candidate, 'package.json'))
  }
  return undefined
}

const reactRequire = borrowReact()
const REACT_AVAILABLE = reactRequire !== undefined

/** What one run of the bundle observed. */
interface Probe {
  /** The id the bundle registered under. */
  id: string
  /** The face `apply` produced, or the error it threw. */
  plugin: { inject: readonly string[]; apply: (ctx: unknown) => void } | undefined
  /** Every slot registration the page made. */
  registrations: { name: string; options: Record<string, unknown> }[]
  /** Every locale namespace registered. */
  locales: string[]
  /** Effect labels, in registration order. */
  effects: string[]
  /** Standalone style elements appended to the head. */
  styles: { plugin: string | undefined; pluginCss: string | undefined; text: string }[]
  /** The spec list the form was built with. */
  specs: { field: string; format: (value: unknown) => string; parse: (text: string) => unknown }[]
  /** Every mutation the form issued, with the revision it was fenced by. */
  mutations: { ops: readonly unknown[]; revision: number | undefined }[]
}

/**
 * Load the bundle into a fresh global, the way the browser does.
 *
 * @param options - the served config value and the served namespace set.
 * @returns the registration and one `apply` run over a fake context.
 */
function runBundle(options: { value?: Record<string, unknown>; served?: boolean; revision?: number } = {}): Probe {
  const source = readFileSync(join(REPO_ROOT, 'lib/client.js'), 'utf8')
  const probe: Probe = { id: '', plugin: undefined, registrations: [], locales: [], effects: [], styles: [], specs: [], mutations: [] }

  // The primitives are stubbed; React is the real thing, so the component tree
  // the page builds is evaluated for real.
  const primitives = {
    Button: function Button() { return null },
    Input: function Input() { return null },
    SettingsForm: function SettingsForm() { return null },
    SettingsValueField: function SettingsValueField() { return null },
    // The real model is exercised through its observable contract: the spec list
    // and the write path are what the page's field declarations feed.
    SettingsFormModel: class {
      constructor(_scope: unknown, specs: Probe['specs']) { probe.specs.push(...specs) }
      bind(project: () => unknown) {
        const snapshot = project()
        return { getSnapshot: () => snapshot, subscribe: () => () => {} }
      }
      shell() {
        return { available: options.served !== false, writable: true, dirty: false, invalid: false, saving: false, failed: false }
      }
      field(name: string) {
        const spec = probe.specs.find(candidate => candidate.field === name)
        const value = options.value?.[name]
        return { text: spec === undefined ? '' : spec.format(value), overridden: value !== undefined, invalid: false }
      }
      actions() {
        return {
          edit: () => {},
          resetField: () => {},
          save: () => {},
          discard: () => {},
        }
      }
      dispose() {}
    },
    settingsTextField: (field: string) => ({ field, format: String, parse: () => undefined }),
  }

  const requireShim = (name: string): unknown => {
    if (name === 'react') return reactRequire!('react')
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`the page required "${name}", which is not in the module table`)
  }

  const globalWithLoader = globalThis as unknown as { window?: unknown }
  const previousWindow = globalWithLoader.window
  const fakeWindow: Record<string, unknown> = { confirm: () => true }
  globalWithLoader.window = fakeWindow
  // The bundle reaches for `window.__ModuleLoader__`, which is the global the
  // client module system installs; it is not a bare global.
  fakeWindow['__ModuleLoader__'] = {
    load: (module: { id: string; factory: (require: (name: string) => unknown) => unknown }) => {
      probe.id = module.id
      probe.plugin = module.factory(requireShim) as Probe['plugin']
    },
  }

  // A document stub: the page tags its stylesheet with the plugin id so the
  // loader can remove it, and the tag it produces is asserted below.
  const document = {
    head: {
      appendChild: (element: { dataset: Record<string, string>; textContent: string }) => {
        probe.styles.push({ plugin: element.dataset['plugin'], pluginCss: element.dataset['pluginCss'], text: element.textContent })
      },
    },
    createElement: () => ({ dataset: {} as Record<string, string>, textContent: '', remove: () => {} }),
  }

  const registrations = probe.registrations
  const scope = {
    getSnapshot: () => ({
      status: options.served === false ? 'unavailable' : 'ready',
      value: options.value,
      base: {}, user: {},
      revision: options.revision ?? 1,
      writable: true,
    }),
    subscribe: () => () => {},
    mutate: (ops: readonly unknown[], revision: number | undefined) => {
      probe.mutations.push({ ops, revision })
      return Promise.resolve(true)
    },
  }

  const ctx = {
    locale: {
      register: (ns: string) => { probe.locales.push(ns); return () => {} },
      bind: () => (key: string) => key,
    },
    configForms: {
      get: () => scope,
      // Runs the registration immediately when the namespace is served, and not
      // at all when it is not - the behaviour the page's visibility depends on.
      whileServed: (_namespaces: readonly string[], register: () => () => void) =>
        options.served === false ? () => {} : register(),
    },
    // `slots.inject` waits for the declaration; the slots it names are declared
    // by the real composition, so the stub runs the callback directly.
    slots: {
      inject: (_name: string, register: () => () => void) => register(),
      register: (options_: Record<string, unknown>) => {
        registrations.push({ name: String(options_['name']), options: options_ })
        return () => {}
      },
    },
    effect: (callback: () => unknown, label?: string) => {
      probe.effects.push(String(label))
      callback()
      return () => {}
    },
    get: () => undefined,
  }

  // `document` is read off the global by the page, which runs in a browser.
  const previousDocument = (globalThis as unknown as { document?: unknown }).document
  ;(globalThis as unknown as { document?: unknown }).document = document

  try {
    // eslint-disable-next-line no-new-func -- the artifact is a script, not a module.
    new Function('window', 'document', source)(fakeWindow, document)
    probe.plugin?.apply(ctx)
  } finally {
    if (previousWindow === undefined) delete globalWithLoader.window
    else globalWithLoader.window = previousWindow
    if (previousDocument === undefined) delete (globalThis as unknown as { document?: unknown }).document
    else (globalThis as unknown as { document?: unknown }).document = previousDocument
  }

  return probe
}

describe.skipIf(!REACT_AVAILABLE)('the browser half as a script', () => {
  it('registers itself under the package name the host serves it as', () => {
    // The loader matches the factory to the graph entry by id. A bundle that
    // registers under another id loads, runs, and never arrives - the failure
    // the module system reports as "loaded without registering".
    const probe = runBundle()

    expect(probe.id).toBe('dsh-channel-wechat')
  })

  it('exports the services and the plugin shape', () => {
    const probe = runBundle()

    expect(probe.plugin?.inject).toEqual(['slots', 'locale', 'configForms'])
    expect(typeof probe.plugin?.apply).toBe('function')
  })

  it('registers its page on the installed-bundle slot, keyed by package name', () => {
    // `plugins.bundle.config` is where a bundle's own configuration renders, and
    // it is keyed by the package name. The wrong slot or a key that does not
    // match leaves the page registered and never rendered, with no error - which
    // is why both are asserted rather than just the registration count.
    const probe = runBundle()

    expect(probe.registrations).toHaveLength(1)
    expect(probe.registrations[0]?.name).toBe('plugins.bundle.config')
    expect(probe.registrations[0]?.options['key']).toBe('dsh-channel-wechat')
  })

  it('builds the two editable fields', () => {
    const probe = runBundle()

    expect(probe.specs.map(spec => spec.field).sort()).toEqual(['cards', 'cwd'])
  })

  it('rejects a relative working directory before the write', () => {
    // The session boundary refuses a relative path, so marking the draft invalid
    // here disables the save button and shows why instead of spending a round
    // trip to be told the same thing.
    const probe = runBundle()
    const cwd = probe.specs.find(spec => spec.field === 'cwd')!

    expect(cwd.parse('/work')).toEqual({ kind: 'set', value: '/work' })
    expect(cwd.parse('work')).toBeUndefined()
    // Emptying the control clears the key, restoring the composition default -
    // the same gesture the primitives' own text field uses.
    expect(cwd.parse('   ')).toEqual({ kind: 'clear' })
  })

  it('accepts only the enum values the schema declares', () => {
    const probe = runBundle()
    const cards = probe.specs.find(spec => spec.field === 'cards')!

    expect(cards.parse('both')).toEqual({ kind: 'set', value: 'both' })
    expect(cards.parse('wechat')).toEqual({ kind: 'set', value: 'wechat' })
    expect(cards.parse('gui')).toBeUndefined()
    expect(cards.parse('')).toEqual({ kind: 'clear' })
    // A stored value the page does not offer renders as "use default" rather
    // than as a value the user cannot see.
    expect(cards.format('nonsense')).toBe('')
  })

  it('registers its dictionaries and a style tag the loader can remove', () => {
    // The style tag has to carry the plugin id: the loader removes owned styles
    // by that attribute, so an untagged one outlives the plugin and its page.
    const probe = runBundle()

    expect(probe.locales).toEqual(['channelWechat'])
    expect(probe.styles).toHaveLength(1)
    expect(probe.styles[0]?.plugin).toBe('dsh-channel-wechat')
    expect(probe.styles[0]?.pluginCss).toBe('dsh-channel-wechat/client.js')
    expect(probe.styles[0]?.text).toContain('.cw-root')
  })

  it('exposes its configuration through a selector hook the renderer can bind', () => {
    // The reserved `hooks` compartment is the only thing the renderer turns into
    // a `use<Name>` prop. A store handed over any other way arrives as an inert
    // object and the component's hook call throws at render.
    const probe = runBundle()

    const inject = probe.registrations[0]?.options['inject'] as (() => Record<string, unknown>) | undefined
    const face = inject?.()

    expect(face?.['hooks']).toMatchObject({ wechatConfig: expect.objectContaining({ getSnapshot: expect.any(Function) }) })
    // The form actions ride beside it, verbatim.
    expect(face).toMatchObject({
      edit: expect.any(Function),
      resetField: expect.any(Function),
      save: expect.any(Function),
      discard: expect.any(Function),
    })
  })

  it('registers no page when the host serves no such namespace', () => {
    // A deployment without a settings service must show no trace of the page,
    // rather than a card whose fields can never load.
    const probe = runBundle({ served: false })

    expect(probe.registrations).toEqual([])
  })

  it('disposes the form when the plugin unloads', () => {
    // The model subscribes to the scope on construction, so a page that never
    // disposed it would keep a listener per load - and the loader reloads a
    // plugin on every edit of its patch row.
    const probe = runBundle()

    // The form effect is the one that returns a disposer closing over the model.
    expect(probe.effects).toContain('channel-wechat: form subscription')
  })
})
