/**
 * The writable half of `/model`.
 *
 * One property matters here and it is not obvious from the code: the write must
 * be **detached**. A profile edit reloads this plugin's row, the reload disposes
 * the row, the row's disposer awaits `Channel.stop()`, and `stop()` awaits every
 * in-flight command - including the `/model` call that asked for the edit.
 * Awaiting `edit()` inside the command therefore waits on itself, and the run
 * hangs until the Host's shutdown deadline kills it.
 *
 * That is a property of the wiring, so it is asserted here rather than left to
 * the integration suite: a test that builds a `Channel` above a fake editor
 * would be testing the fake.
 */

import { describe, expect, it, vi } from 'vitest'
import { createModelCommands } from '../../src/channel/model-config.ts'

/**
 * A context exposing just the two things the writer reads.
 * @param options - the editor and the entry; `entry: undefined` means the plugin
 * was mounted without a Loader, which is a real composition.
 * @returns a context-shaped object.
 */
function context(options: {
  edit?: (entry: unknown, change: (current: Record<string, unknown>) => Record<string, unknown>) => Promise<void>
  entry?: unknown
}) {
  const edit = options.edit ?? vi.fn(async () => {})
  // Not `?? {}`: an explicitly absent entry is the case one test needs.
  const entry = 'entry' in options ? options.entry : {}
  return {
    ctx: { get: (name: string) => name === 'configEditor' ? { edit } : undefined, fiber: { entry } } as never,
    edit,
  }
}

/** The volatile fields the command reads back. */
function fields(provider = '', model = '') {
  return { provider: { get: () => provider }, model: { get: () => model } }
}

describe('switchModel', () => {
  it('returns while the write is still pending', async () => {
    // The whole point: an edit that never settles - which is what a reload
    // waiting on this very run looks like - must not hold the reply hostage.
    let released: (() => void) | undefined
    const { ctx } = context({
      edit: async () => { await new Promise<void>(resolve => { released = resolve }) },
    })
    const commands = createModelCommands(ctx, fields(), undefined, () => {})

    const settled = await Promise.race([
      commands.switchModel!({ provider: 'provider-b', model: 'model-b1' }).then(() => 'returned' as const),
      // A generous bound: the point is that it does not wait for the write, not
      // that it is fast.
      new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 1_000)),
    ])
    released?.()

    expect(settled).toBe('returned')
  })

  it('writes the two config fields and changes nothing else', async () => {
    const seen: Record<string, unknown>[] = []
    const { ctx } = context({
      edit: async (_entry, change) => { seen.push(change({ cwd: '/work', provider: '', model: '', cards: 'both' })) },
    })
    const commands = createModelCommands(ctx, fields(), undefined, () => {})

    await commands.switchModel!({ provider: 'provider-b', model: 'model-b1' })
    // The write is detached, so its callback runs on a later turn.
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(seen[0]).toEqual({ cwd: '/work', provider: 'provider-b', model: 'model-b1', cards: 'both' })
  })

  it('reports a failed write instead of swallowing it', async () => {
    // The cost of detaching: the user cannot see this failure. The log must.
    const report = vi.fn()
    const { ctx } = context({ edit: async () => { throw new Error('disk full') } })
    const commands = createModelCommands(ctx, fields(), undefined, report)

    await commands.switchModel!({ provider: 'provider-b', model: 'model-b1' })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(report).toHaveBeenCalledOnce()
    expect(String(report.mock.calls[0]?.[1])).toContain('disk full')
  })

  it('refuses when the deployment has no config editor', async () => {
    const ctx = { get: () => undefined, fiber: { entry: {} } } as never
    const commands = createModelCommands(ctx, fields(), undefined, () => {})

    await expect(commands.switchModel!({ provider: 'p', model: 'm' })).rejects.toThrow(/可写/u)
  })

  it('refuses when the plugin has no config row', async () => {
    // Mounted without a Loader: there is no row to edit, and silently doing
    // nothing would tell the user their model changed when it did not.
    const { ctx } = context({ entry: undefined })
    const commands = createModelCommands(ctx, fields(), undefined, () => {})

    await expect(commands.switchModel!({ provider: 'p', model: 'm' })).rejects.toThrow(/配置行/u)
  })
})

describe('the reading half', () => {
  it('reports the configured pair as current', () => {
    const { ctx } = context({})
    const commands = createModelCommands(ctx, fields('provider-a', 'model-a1'), undefined, () => {})

    expect(commands.current()).toEqual({ provider: 'provider-a', model: 'model-a1' })
  })

  it('has no catalogue when the deployment composed no LLM registry', () => {
    const { ctx } = context({})
    const commands = createModelCommands(ctx, fields(), undefined, () => {})

    expect(commands.listModels).toBeUndefined()
  })

  it('reads the live registry rather than a list of its own', async () => {
    const { ctx } = context({})
    const llm = {
      listProviders: () => [{ id: 'provider-a', name: 'Provider A' }],
      listModels: async () => [{ id: 'model-a1', name: 'A1' }],
    }
    const commands = createModelCommands(ctx, fields(), llm, () => {})

    const catalog = await commands.listModels!()

    expect(catalog.options).toEqual([
      { provider: 'provider-a', model: 'model-a1', label: 'A1', providerLabel: 'Provider A' },
    ])
  })
})
