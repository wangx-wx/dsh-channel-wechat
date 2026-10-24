/**
 * The plugin page's interactive behaviour, executed.
 *
 * The sibling suite (`client-half-runs.spec.ts`) proves the bundle loads, wires
 * its slot, and builds its field specs. None of that observes what happens when
 * a user operates a control, and one of those interactions is
 * **safety-critical**: choosing `danger-full-access` is what turns this plugin's
 * own WeChat approval cards off, because the preset bundles `approval: never`,
 * which the approval service settles *before* the waterfall those cards join.
 *
 * The gate in front of that choice is a comparison, and an inverted one fails
 * silently - the dialog would simply stop appearing and the widest preset would
 * apply on the first click. So it is driven here, against the shipped bytes.
 *
 * No DOM is needed. The bundle asks its `require` for React, so this supplies a
 * minimal hooks implementation and walks the element tree itself; that is enough
 * to activate a control and re-render, which is all these assertions need.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REPO_ROOT } from '../support/harness.ts'

/**
 * A React replacement with just enough hooks to render this page.
 *
 * State lives in one flat array walked in render order, which is how React
 * itself keys a tree whose shape does not change between renders.
 *
 * @returns the module to hand the bundle.
 */
function fakeReact() {
  const states: unknown[] = []
  const effects: (() => unknown)[] = []
  let cursor = 0
  return {
    /** Reset the hook cursor; called once per render pass. */
    beginRender: () => { cursor = 0 },
    module: {
      createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
        const merged: Record<string, unknown> = { ...props }
        if (children.length > 0) merged['children'] = children
        return { type, props: merged }
      },
      useState(initial: unknown) {
        const index = cursor
        cursor += 1
        if (!(index in states)) states[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
        return [
          states[index],
          (next: unknown) => {
            states[index] = typeof next === 'function' ? (next as (current: unknown) => unknown)(states[index]) : next
          },
        ]
      },
      // Run the effect once, the way a mount does. A no-op here made any
      // on-mount fetch invisible to these tests: the callback that issued it was
      // never invoked, so an assertion about it passed for the wrong reason.
      // Effects keyed on a dependency list are not re-run (there is no second
      // render to key them against), which is what a mount does anyway.
      useEffect(effect: () => unknown) {
        effects.push(effect)
      },
    },
    /** Effects collected during the last render pass, in call order. */
    effects,
  }
}

/** One rendered node, after component functions have been invoked. */
interface Rendered {
  type: unknown
  props: Record<string, unknown>
  children: unknown
}

/** Invoke every function component in an element tree, leaving host elements behind. */
function render(node: unknown): unknown {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(render)
  if (typeof node !== 'object') return node
  const element = node as { type: unknown, props: Record<string, unknown> }
  if (typeof element.type === 'function') {
    return render((element.type as (props: Record<string, unknown>) => unknown)(element.props))
  }
  if (element.type === undefined) return null
  return {
    type: element.type,
    props: element.props,
    children: render(element.props['children'] ?? null),
  } satisfies Rendered
}

/** Every rendered node whose marker type is `type`, in tree order. */
function findAll(node: unknown, type: string, found: Rendered[] = []): Rendered[] {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) { for (const child of node) findAll(child, type, found); return found }
  const rendered = node as Rendered
  if (rendered.type === type) found.push(rendered)
  findAll(rendered.children, type, found)
  return found
}

/**
 * Markers the primitive stubs render, so the page's trees can be searched.
 *
 * The bundle requires the primitives from the module table, so the table is
 * where these are replaced. They carry no behaviour: the assertions are about
 * which props the page passed them.
 */
const MARK = {
  segmented: '__SegmentedControl',
  risk: '__RiskConfirmation',
  menu: '__Menu',
  valueField: '__SettingsValueField',
  button: '__Button',
} as const

/** Flatten a render tree into the visible text it would produce. */
function texts(node: unknown, found: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return found
  if (Array.isArray(node)) { for (const child of node) texts(child, found); return found }
  if (typeof node !== 'object') { found.push(String(node)); return found }
  texts((node as Rendered).children, found)
  return found
}

/** The first rendered button whose label is `label`. */
function button(page: Page, label: string): Rendered {
  const found = findAll(page.draw(), MARK.button)
    .filter(node => texts(node.children).includes(label))
  expect(found).toHaveLength(1)
  return found[0]!
}

/** Press the button labelled `key` (the dictionaries pass keys through here). */
function click(page: Page, key: string): void {
  ;(button(page, key).props['onClick'] as () => void)()
}

/**
 * Let a resolved fetch's `.then` callbacks run.
 *
 * The page's handlers are promise chains, so a press returns before its state
 * has been folded in. Two microtask turns is enough for `json()` plus the
 * handler that follows it.
 */
async function settle(): Promise<void> {
  // Each press is a chain: `fetch` -> `json()` -> the handler that sets state,
  // and the command costs a second chain that starts inside the first. Twenty
  // turns drains both without waiting on a real timer.
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
}

/**
 * A wire that answers the two update routes, recording what was asked.
 *
 * @param check - the body the check route should answer.
 * @returns the wire, the URLs it was asked, and a per-route count.
 */
function checkResponse(check: unknown): {
  wire: (input: string | URL | Request) => Promise<Response>
  asked: string[]
  answer: (next: unknown) => void
  noCommand: () => void
} {
  const asked: string[] = []
  let body = check
  let commandAnswers = true
  const wire = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    asked.push(url)
    if (url.includes('update/check')) return new Response(JSON.stringify(body))
    if (url.includes('update/command')) {
      return commandAnswers
        ? new Response(JSON.stringify({ command: '/n node /d/lib/bin.js plugin --profile web add dsh-channel-wechat@latest', desktop: false, profile: 'web', spec: 'dsh-channel-wechat@latest' }))
        : new Response(JSON.stringify({ error: '此部署无法生成更新命令' }), { status: 501 })
    }
    return new Response(JSON.stringify({ phase: 'connected' }))
  }
  return {
    wire,
    asked,
    answer: (next: unknown) => { body = next },
    noCommand: () => { commandAnswers = false },
  }
}

/** What one render produced, and how to produce the next. */
interface Page {
  /** Render again and return the tree, so state changes are observable. */
  readonly draw: () => unknown
  /** The field edits the page staged, in order. */
  readonly edited: { field: string, text: string }[]
  /** The fields the page asked to reset, in order. */
  readonly reset: string[]
}

/**
 * Load the shipped bundle and produce a renderer for the page it registers.
 *
 * @param config - the permission, provider and model the form currently holds.
 * @param fetchImpl - the wire the page sees. Absent installs a promise that never
 *   settles, so the connection half's poll neither resolves nor schedules a
 *   retry that would outlive the test.
 * @returns the page renderer and the edits it records.
 */
function loadPage(
  config: { permission: string, provider?: string, model?: string },
  fetchImpl?: (input: string | URL | Request) => Promise<Response>,
): Page {
  const source = readFileSync(join(REPO_ROOT, 'lib/client.js'), 'utf8')
  const react = fakeReact()
  const edited: { field: string, text: string }[] = []
  const reset: string[] = []

  const marker = (type: string) => (props: Record<string, unknown>) => ({ type, props })
  const state = {
    cwd: { text: '/work', overridden: false, invalid: false },
    cards: { text: 'wechat', overridden: false, invalid: false },
    permission: { text: config.permission, overridden: false, invalid: false },
    provider: { text: config.provider ?? '', overridden: false, invalid: false },
    model: { text: config.model ?? '', overridden: false, invalid: false },
    // The admission list is drawn as one more text field. Left empty, which is
    // also the meaningful default: it admits the account that scanned the login.
    allow: { text: '', overridden: false, invalid: false },
  }
  const primitives: Record<string, unknown> = {
    // Transparent, so the fields under test are the nodes that survive rendering.
    SettingsForm: (props: Record<string, unknown>) => props['children'],
    SettingsValueField: marker(MARK.valueField),
    SegmentedControl: marker(MARK.segmented),
    RiskConfirmation: marker(MARK.risk),
    Menu: marker(MARK.menu),
    Button: marker('__Button'),
    Input: marker('__Input'),
    SettingsFormModel: class {
      bind() { return { getSnapshot: () => ({}), subscribe: () => () => {} } }
      shell() { return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false } }
      field() { return { text: '', overridden: false, invalid: false } }
      actions() { return { edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {} } }
      dispose() {}
    },
  }

  // The connection half fetches on mount. A promise that never settles keeps its
  // poll from scheduling a retry timer that would outlive the test. A caller that
  // wants to observe requests supplies its own wire instead.
  vi.stubGlobal('fetch', fetchImpl === undefined
    ? vi.fn(() => new Promise(() => {})) as unknown as typeof fetch
    : fetchImpl as unknown as typeof fetch)

  let component: ((props: Record<string, unknown>) => unknown) | undefined
  const ctx = {
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    configForms: {
      get: () => ({
        getSnapshot: () => ({ value: {}, base: {}, user: {}, revision: 1, writable: true }),
        subscribe: () => () => {},
        mutate: async () => true,
      }),
      whileServed: (_namespaces: readonly string[], register: () => () => void) => register(),
    },
    slots: {
      inject: (_name: string, register: () => () => void) => register(),
      register: (_options: Record<string, unknown>, registered?: unknown) => {
        component = registered as typeof component
        return () => {}
      },
    },
    effect: (callback: () => unknown) => { callback(); return () => {} },
    get: () => undefined,
  }

  const previousWindow = (globalThis as { window?: unknown }).window
  const fakeWindow: Record<string, unknown> = {}
  fakeWindow['__ModuleLoader__'] = {
    load: (module: { factory: (require: (name: string) => unknown) => unknown }) => {
      const plugin = module.factory((name: string) => {
        if (name === 'react') return react.module
        if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
        throw new Error(`the page required "${name}", which is not in the module table`)
      }) as { apply: (ctx: unknown) => void }
      plugin.apply(ctx)
    },
  }
  ;(globalThis as { window?: unknown }).window = fakeWindow
  const previousDocument = (globalThis as { document?: unknown }).document
  ;(globalThis as { document?: unknown }).document = {
    head: { appendChild: () => {} },
    createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
  }
  try {
    // eslint-disable-next-line no-new-func -- the artifact is a script, not a module.
    new Function('window', 'document', source)(fakeWindow, (globalThis as { document?: unknown }).document)
  } finally {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = previousWindow
    if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document
    else (globalThis as { document?: unknown }).document = previousDocument
  }

  if (component === undefined) throw new Error('the page registered no component')

  return {
    draw: () => {
      react.beginRender()
      react.effects.length = 0
      const tree = render(component!({
        // Keys pass through, with their parameters appended: an assertion can
        // then see both which string was chosen and what was filled in. A `t`
        // that dropped the parameters made "the page shows the version the Host
        // reported" unobservable - every render said `currentVersion` and no
        // number.
        t: (key: string, params?: Record<string, unknown>) => params === undefined
          ? key
          : `${key} ${Object.values(params).map(value => String(value)).join(' ')}`,
        // The renderer hands the component a `use<Name>` hook per `hooks` source;
        // this is that hook, returning the state the test set up.
        useWechatConfig: (selector: (snapshot: unknown) => unknown) => selector(state),
        edit: (field: string, text: string) => { edited.push({ field, text }) },
        resetField: (field: string) => { reset.push(field) },
        save: () => {},
        discard: () => {},
      }))
      // Mount effects run after the tree is committed, which is when the page's
      // on-mount fetches fire. Collected first so a test can render again without
      // re-running an earlier mount's effect.
      for (const effect of [...react.effects]) effect()
      return tree
    },
    edited,
    reset,
  }
}

/** The permission control the page rendered. */
function permissionControl(tree: unknown): Rendered {
  const controls = findAll(tree, MARK.segmented).filter(node => node.props['id'] === 'cw-permission')
  expect(controls).toHaveLength(1)
  return controls[0]!
}

/** The risk confirmation the page rendered. */
function confirmation(tree: unknown): Rendered {
  const found = findAll(tree, MARK.risk)
  expect(found).toHaveLength(1)
  return found[0]!
}

afterEach(() => { vi.unstubAllGlobals() })

describe('choosing a wider permission than the one in force', () => {
  it('opens the risk confirmation instead of applying it outright', () => {
    // The whole point: without this gate the widest preset is one click away, and
    // the user loses the approval cards that are this plugin's only way to ask.
    const page = loadPage({ permission: 'workspace-write' })
    const control = permissionControl(page.draw())

    ;(control.props['onChange'] as (next: string) => void)('danger-full-access')

    const dialog = confirmation(page.draw())
    expect(dialog.props['open']).toBe(true)
    // Nothing is staged while the dialog is open: the choice is not made yet.
    expect(page.edited).toEqual([])
  })

  it('stages nothing until the risk is acknowledged and confirmed', () => {
    const page = loadPage({ permission: 'workspace-write' })
    ;(permissionControl(page.draw()).props['onChange'] as (next: string) => void)('danger-full-access')

    const dialog = confirmation(page.draw())
    expect(dialog.props['acknowledged']).toBe(false)
    // The primitive disables its primary action until this is true; the page
    // only has to pass the flag through and act on confirm.
    expect(typeof dialog.props['onAcknowledgedChange']).toBe('function')

    ;(dialog.props['onConfirm'] as () => void)()

    expect(page.edited).toEqual([{ field: 'permission', text: 'danger-full-access' }])
  })

  it('cancels without staging anything, and closes the dialog', () => {
    const page = loadPage({ permission: 'workspace-write' })
    ;(permissionControl(page.draw()).props['onChange'] as (next: string) => void)('danger-full-access')

    ;(confirmation(page.draw()).props['onCancel'] as () => void)()

    expect(page.edited).toEqual([])
    expect(confirmation(page.draw()).props['open']).toBe(false)
  })

  it('does not ask again when the widest preset is already in force', () => {
    // Re-picking the value already set changes nothing, and a dialog that appears
    // for a no-op trains the user to click through the one that matters.
    const page = loadPage({ permission: 'danger-full-access' })
    const control = permissionControl(page.draw())

    ;(control.props['onChange'] as (next: string) => void)('danger-full-access')

    expect(confirmation(page.draw()).props['open']).toBe(false)
  })
})

describe('choosing a preset that keeps the approval cards', () => {
  it('applies it directly, with no dialog', () => {
    // The other side of the gate: an over-eager comparison would put a risk
    // dialog in front of `read-only`, which would be its own kind of wrong.
    const page = loadPage({ permission: 'workspace-write' })

    ;(permissionControl(page.draw()).props['onChange'] as (next: string) => void)('read-only')

    expect(page.edited).toEqual([{ field: 'permission', text: 'read-only' }])
    expect(confirmation(page.draw()).props['open']).toBe(false)
  })

  it('offers all three presets, including the widest', () => {
    const page = loadPage({ permission: 'workspace-write' })
    const options = permissionControl(page.draw()).props['options'] as { value: string }[]

    expect(options.map(option => option.value))
      .toEqual(['read-only', 'workspace-write', 'danger-full-access'])
  })
})

describe('the model control', () => {
  it('stages both halves of the pair when a model is chosen', () => {
    // The pair is one setting in two fields; staging only half of it would write
    // a provider with a stale model, which `resolveModelSelection` refuses at the
    // next session rather than here.
    const page = loadPage({ permission: 'workspace-write' })
    const menu = findAll(page.draw(), MARK.menu)[0]!
    const items = menu.props['items'] as { id: string, label: string }[]

    // Only the "follow the default" row exists before the catalogue arrives.
    expect(items).toHaveLength(1)

    // The row id is JSON, so a model id containing a slash cannot be mis-decoded.
    const rowId = JSON.stringify(['meta', 'llama/Llama-3'])
    ;(menu.props['onSelect'] as (id: string) => void)(rowId)

    expect(page.edited).toEqual([
      { field: 'provider', text: 'meta' },
      { field: 'model', text: 'llama/Llama-3' },
    ])
  })

  it('clears both halves when "follow the default" is chosen', () => {
    const page = loadPage({ permission: 'workspace-write', provider: 'p', model: 'm' })
    const menu = findAll(page.draw(), MARK.menu)[0]!

    ;(menu.props['onSelect'] as (id: string) => void)('')

    expect(page.reset).toEqual(['provider', 'model'])
    expect(page.edited).toEqual([])
  })

  it('ignores a row id this page did not produce', () => {
    // Row ids are opaque keys. A stale or foreign id must be refused rather than
    // parsed into a pair that was never offered.
    const page = loadPage({ permission: 'workspace-write' })
    const menu = findAll(page.draw(), MARK.menu)[0]!

    for (const id of ['not json', 'null', '["only-one"]', '[1,2]', '{}']) {
      ;(menu.props['onSelect'] as (id: string) => void)(id)
    }

    expect(page.edited).toEqual([])
    expect(page.reset).toEqual([])
  })
})

describe('the version card on the page', () => {
  it('is rendered last, after the settings card', () => {
    // Placement is a product decision with a test: an update is a rare action and
    // must not sit above the login or the settings, which are what the page is
    // opened for. A card that drifted to the top would be one more thing to scroll
    // past every time.
    const page = loadPage({ permission: 'workspace-write' })
    const tree = page.draw() as Rendered

    // The last section the page renders is the version card; its heading is the
    // locale key the dictionaries carry.
    const titles = findAll(tree, 'h3').map(node => (node.props['children'] as string[] | string))
    const flat = titles.map(title => Array.isArray(title) ? title.join('') : title)
    expect(flat.at(-1)).toBe('version')
  })

  it('asks the Host nothing until the user presses the button', async () => {
    // Checking on mount made the page a poll the user never asked for, and it
    // answered a question ("is there a newer release?") nobody had posed. The
    // card is now quiet until it is asked: no request, no version number, just
    // the button.
    const asked: string[] = []
    const page = loadPage({ permission: 'workspace-write' }, async (input) => {
      asked.push(String(input))
      return new Promise(() => {})
    })

    page.draw()

    expect(asked.some(url => url.includes('api/channel-wechat/update/'))).toBe(false)
  })

  it('checks when the button is pressed, and shows the version the Host reported', async () => {
    // The running version is read off the installed manifest by the Host. A page
    // that hardcoded it would keep claiming the old number after an update - the
    // exact situation this card exists to resolve.
    const checked = checkResponse({ status: 'ready', current: '0.2.2', latest: '0.2.2', newer: false })
    const page = loadPage({ permission: 'workspace-write' }, checked.wire)

    page.draw()
    click(page, 'checkUpdate')
    await settle()

    expect(checked.asked.filter(url => url.includes('update/check'))).toHaveLength(1)
    // The version the Host reported, not one the page made up.
    expect(texts(page.draw()).join(' | ')).toContain('currentVersion 0.2.2')
  })

  it('does not ask for a command when the running copy is already current', async () => {
    // Only an actual upgrade has instructions to prepare. Asking anyway would
    // make the Host build a command nobody sees.
    const checked = checkResponse({ status: 'ready', current: '0.2.2', latest: '0.2.2', newer: false })
    const page = loadPage({ permission: 'workspace-write' }, checked.wire)

    page.draw()
    click(page, 'checkUpdate')
    await settle()

    expect(checked.asked.some(url => url.includes('update/command'))).toBe(false)
  })

  it('asks for the command when a newer release exists', async () => {
    const checked = checkResponse({ status: 'ready', current: '0.2.2', latest: '0.3.0', newer: true })
    const page = loadPage({ permission: 'workspace-write' }, checked.wire)

    page.draw()
    click(page, 'checkUpdate')
    await settle()

    expect(checked.asked.some(url => url.includes('update/command'))).toBe(true)
    expect(texts(page.draw()).join(' | ')).toContain('0.3.0')
  })

  it('drops the previous command when a later press cannot build one', async () => {
    // The command names a version. A second press that finds a *different*
    // release whose command this deployment cannot build (501) must not leave
    // the previous release's command on screen: the copy button beside it would
    // hand the user a command that installs the wrong version.
    const checked = checkResponse({ status: 'ready', current: '0.2.2', latest: '0.3.0', newer: true })
    const page = loadPage({ permission: 'workspace-write' }, checked.wire)

    page.draw()
    click(page, 'checkUpdate')
    await settle()
    expect(texts(page.draw()).join(' | ')).toContain('dsh-channel-wechat@latest')

    // A newer release appears, but this deployment has no command for it.
    checked.answer({ status: 'ready', current: '0.2.2', latest: '0.3.1', newer: true })
    checked.noCommand()
    click(page, 'checkUpdate')
    await settle()

    const after = texts(page.draw()).join(' | ')
    expect(after).toContain('0.3.1')
    expect(after).toContain('updateNoCommand')
    // The stale command from 0.3.0 must be gone with it.
    expect(after).not.toContain('dsh-channel-wechat@latest')
  })

  it('checks again on a second press, so a release made a minute ago is visible', async () => {
    // The button is the only trigger left. A second press that reused the first
    // answer would leave a just-published version invisible with nothing on
    // screen explaining why.
    const checked = checkResponse({ status: 'ready', current: '0.2.2', latest: '0.2.2', newer: false })
    const page = loadPage({ permission: 'workspace-write' }, checked.wire)

    page.draw()
    click(page, 'checkUpdate')
    await settle()
    click(page, 'checkUpdate')
    await settle()

    expect(checked.asked.filter(url => url.includes('update/check'))).toHaveLength(2)
  })
})
