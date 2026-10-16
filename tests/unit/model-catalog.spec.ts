/**
 * The model choices the page offers.
 *
 * The point of reading these live is that a hardcoded list goes stale: it offers
 * models a provider no longer serves, and misses ones it started serving. The
 * failure is quiet in both directions - the selector renders, the choice is
 * simply wrong - so the shape of what is returned is pinned here rather than
 * left to the page to discover.
 */

import { describe, expect, it } from 'vitest'
import { buildModelOptions, type LlmCatalogLike } from '../../src/channel/model-catalog.ts'

/** A registry whose providers answer as the test says. */
function llmOf(
  providers: Record<string, readonly { id: string; name: string }[] | Error>,
): LlmCatalogLike {
  return {
    listProviders: () => Object.keys(providers).map(id => ({ id, name: `${id} (display)` })),
    listModels: async (id) => {
      const value = providers[id]
      if (value instanceof Error) throw value
      return value ?? []
    },
  }
}

/** A registry whose only provider rejects with a non-Error, as a stringly-typed API might. */
function llmRejectingWithString(): LlmCatalogLike {
  return {
    listProviders: () => [{ id: 'broken', name: 'Broken' }],
    listModels: () => Promise.reject('plain string'),
  }
}

describe('the model catalogue', () => {
  it('lists every model of every provider, in registry order', async () => {
    const catalog = await buildModelOptions(llmOf({
      alpha: [{ id: 'a1', name: 'Alpha One' }, { id: 'a2', name: 'Alpha Two' }],
      beta: [{ id: 'b1', name: 'Beta One' }],
    }))

    expect(catalog.options.map(option => `${option.provider}/${option.model}`))
      .toEqual(['alpha/a1', 'alpha/a2', 'beta/b1'])
    // The label is the model's own name and the group label the provider's, which
    // is what makes the selector readable rather than a list of ids.
    expect(catalog.options[0]).toEqual({
      provider: 'alpha', model: 'a1', label: 'Alpha One', providerLabel: 'alpha (display)',
    })
  })

  it('reports a failing provider instead of dropping the others', async () => {
    // One misconfigured provider must not empty the selector: the models that do
    // answer are still runnable, and a silently short list reads as the user's
    // own mistake.
    const catalog = await buildModelOptions(llmOf({
      alpha: [{ id: 'a1', name: 'Alpha One' }],
      broken: new Error('no credentials'),
    }))

    expect(catalog.options.map(option => option.provider)).toEqual(['alpha'])
    expect(catalog.failures).toEqual([{ provider: 'broken', message: 'no credentials' }])
  })

  it('returns an empty list rather than throwing when nothing is configured', async () => {
    // A deployment with a registry and no providers is a legitimate state, and an
    // exception here would leave the page unable to render its own form.
    await expect(buildModelOptions(llmOf({}))).resolves.toEqual({ options: [], failures: [] })
  })

  it('accepts a provider with no models as an empty group, not a failure', async () => {
    const catalog = await buildModelOptions(llmOf({ empty: [] }))

    expect(catalog.options).toEqual([])
    expect(catalog.failures).toEqual([])
  })

  it('stringifies a non-Error rejection so the reason survives', async () => {
    // A provider adapter is third-party code; a stringly-typed rejection must
    // still name a reason rather than reading as "undefined".
    const catalog = await buildModelOptions(llmRejectingWithString())

    expect(catalog.failures).toEqual([{ provider: 'broken', message: 'plain string' }])
  })
})
