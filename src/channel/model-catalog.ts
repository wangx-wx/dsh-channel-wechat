/**
 * The model choices this page offers.
 *
 * Read from the live LLM registry rather than from a list in this package: the
 * user asked for the choices to match what the environment actually has, and a
 * hardcoded list would go stale the moment a provider is added, removed, or
 * configured out. It would also offer a model the agent registry then refuses to
 * run, which reads as a broken plugin rather than a stale list.
 *
 * Provider failures are isolated per provider, the way the official catalogue
 * does it (`buildModelCatalog` in `api/session-controller/src/catalog.ts`): one
 * misconfigured provider must not empty the whole selector, because the others
 * are still usable.
 *
 * @module dsh-channel-wechat/channel/model-catalog
 */

/** One selectable model. */
export interface ModelOption {
  /** Provider route, as `AgentOptions.provider` takes it. */
  readonly provider: string
  /** Model id, as `AgentOptions.model` takes it. */
  readonly model: string
  /** Display label: the provider's own name for the model. */
  readonly label: string
  /** Which provider this row belongs to, for grouping. */
  readonly providerLabel: string
}

/** The catalogue the page renders. */
export interface ModelCatalog {
  /** Selectable rows in provider order, then the provider's own order. */
  readonly options: readonly ModelOption[]
  /**
   * Providers whose models could not be listed, with why.
   *
   * Reported rather than dropped: an empty selector and a selector missing the
   * provider the user configured look the same on screen, and only one of them
   * is the user's mistake.
   */
  readonly failures: readonly { readonly provider: string; readonly message: string }[]
}

/** The slice of `ctx.llm` this module reads. */
export interface LlmCatalogLike {
  /** Provider routes with a registered adapter. */
  listProviders: () => readonly { readonly id: string; readonly name: string }[]
  /** One provider's models. */
  listModels: (provider: string) => Promise<readonly { readonly id: string; readonly name: string }[]>
}

/**
 * Build the catalogue of models this deployment can actually run.
 *
 * Never throws for a provider failure: a failure is a reported gap, because the
 * page has to render something and an exception here would leave it with no
 * options at all - including the ones that work.
 *
 * @param llm - the live LLM registry.
 * @returns every selectable model, plus the providers that could not answer.
 */
export async function buildModelOptions(llm: LlmCatalogLike): Promise<ModelCatalog> {
  const options: ModelOption[] = []
  const failures: { provider: string; message: string }[] = []

  for (const provider of llm.listProviders()) {
    try {
      const models = await llm.listModels(provider.id)
      for (const model of models) {
        options.push({
          provider: provider.id,
          model: model.id,
          label: model.name,
          providerLabel: provider.name,
        })
      }
    } catch (error: unknown) {
      failures.push({
        provider: provider.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { options, failures }
}
