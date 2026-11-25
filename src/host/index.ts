import type { Context } from '@deepseek-ai/cordis'
import type { ModelEffortOption, ModelPointerEntry } from '../shared/pointer.ts'
import {
  formatModelPointer,
  parseModelPointer,
  PLUGIN_ID,
  scoreModelEntry,
} from '../shared/pointer.ts'

interface LlmProviderInfoLike {
  id: string
  name?: string
}

interface LlmModelInfoLike {
  id: string
  name?: string
  description?: string
  reasoningEfforts?: readonly { id: string, name?: string, description?: string }[]
  defaultReasoningEffort?: string
  reasoning?: {
    efforts?: readonly { id: string, name?: string, description?: string }[]
    defaultEffort?: string
  }
}

interface LlmServiceLike {
  listProviders?: () => readonly LlmProviderInfoLike[]
  listModels?: (provider: string) => Promise<readonly LlmModelInfoLike[]> | readonly LlmModelInfoLike[]
  resolveModelInfo?: (provider: string, model: string) => Promise<LlmModelInfoLike | undefined> | LlmModelInfoLike | undefined
}

interface ToolsServiceLike {
  register: (tool: {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: {
      formatModel: (value: unknown) => { content: Array<{ type: 'text', text: string }> }
    }
    isConcurrencySafe?: () => boolean
    isReadOnly?: () => boolean
    execute: (args: Record<string, unknown>) => Promise<unknown>
  }) => () => void
}

function normalizeEfforts(model: LlmModelInfoLike): { efforts: ModelEffortOption[], defaultEffort?: string } {
  const rawList = Array.isArray(model.reasoning?.efforts)
    ? model.reasoning.efforts
    : Array.isArray(model.reasoningEfforts)
      ? model.reasoningEfforts
      : []
  const efforts: ModelEffortOption[] = []
  for (const item of rawList) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || item.id.trim().length === 0)
      continue
    efforts.push({
      id: item.id.trim(),
      name: typeof item.name === 'string' && item.name.trim().length > 0 ? item.name.trim() : item.id.trim(),
      ...(typeof item.description === 'string' && item.description.trim().length > 0 ? { description: item.description.trim() } : {}),
    })
  }
  const defaultEffort = model.reasoning?.defaultEffort ?? model.defaultReasoningEffort
  return {
    efforts,
    ...(typeof defaultEffort === 'string' && defaultEffort.trim().length > 0 ? { defaultEffort: defaultEffort.trim() } : {}),
  }
}

export async function collectHostModelCatalog(llm: LlmServiceLike | undefined): Promise<ModelPointerEntry[]> {
  if (!llm || typeof llm.listProviders !== 'function')
    return []

  let rawProviders: unknown
  try {
    rawProviders = llm.listProviders()
  }
  catch {
    return []
  }
  if (!Array.isArray(rawProviders))
    return []

  const perProvider = await Promise.all(rawProviders.map(async (provider): Promise<ModelPointerEntry[]> => {
    if (!provider || typeof provider !== 'object' || typeof provider.id !== 'string' || provider.id.trim().length === 0)
      return []
    let models: readonly LlmModelInfoLike[] = []
    if (typeof llm.listModels === 'function') {
      try {
        const res = await llm.listModels(provider.id)
        models = Array.isArray(res) ? res : []
      }
      catch {
        models = []
      }
    }
    const providerName = typeof provider.name === 'string' && provider.name.trim().length > 0
      ? provider.name.trim()
      : provider.id
    const entries: ModelPointerEntry[] = []
    for (const m of models) {
      if (!m || typeof m !== 'object' || typeof m.id !== 'string' || m.id.trim().length === 0)
        continue
      let resolvedModel: LlmModelInfoLike = m
      let { efforts, defaultEffort } = normalizeEfforts(m)
      if (efforts.length === 0 && typeof llm.resolveModelInfo === 'function') {
        try {
          const info = await llm.resolveModelInfo(provider.id, m.id)
          if (info && typeof info === 'object') {
            resolvedModel = info
            const resolved = normalizeEfforts(info)
            efforts = resolved.efforts
            defaultEffort = resolved.defaultEffort ?? defaultEffort
          }
        }
        catch {
          // Best-effort reasoning-effort enrichment
        }
      }
      entries.push({
        provider: provider.id,
        providerName,
        model: m.id,
        modelName: typeof m.name === 'string' && m.name.trim().length > 0
          ? m.name.trim()
          : (typeof resolvedModel.name === 'string' && resolvedModel.name.trim().length > 0 ? resolvedModel.name.trim() : m.id),
        ...(typeof m.description === 'string' && m.description.length > 0 ? { description: m.description } : {}),
        efforts,
        ...(defaultEffort !== undefined ? { defaultEffort } : {}),
      })
    }
    return entries
  }))

  return perProvider.flat()
}

export function registerModelPointerHost(ctx: Context): void {
  ctx.inject(['tools', 'llm'], (toolCtx) => {
    const tools = toolCtx.get('tools') as ToolsServiceLike | undefined
    if (typeof tools?.register !== 'function')
      return

    const unregister = tools.register({
      name: 'resolve_model_pointer',
      description: 'Resolve, validate, or search canonical @model[provider/model@effort] pointers against all providers and models currently available in DSH.',
      parameters: {
        type: 'object',
        properties: {
          pointer: {
            type: 'string',
            description: 'Optional canonical pointer to resolve & validate (e.g. "@model[provider-a/model-x@high]" or "provider-a/model-x").',
          },
          query: {
            type: 'string',
            description: 'Optional search filter (provider or model name/id) when browsing available model pointers.',
          },
        },
        additionalProperties: false,
      },
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      output: {
        formatModel: (value) => ({
          content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        }),
      },
      async execute(args) {
        const llm = toolCtx.get('llm') as LlmServiceLike | undefined
        const catalog = await collectHostModelCatalog(llm)
        const rawPointer = typeof args.pointer === 'string' ? args.pointer.trim() : ''

        if (rawPointer.length > 0) {
          const parsed = parseModelPointer(rawPointer)
          if (parsed === undefined) {
            return {
              valid: false,
              error: `Invalid model pointer "${rawPointer}". Expected "@model[provider/model]" or "@model[provider/model@effort]".`,
            }
          }
          const match = catalog.find(e => e.provider === parsed.provider && e.model === parsed.model)
          if (match === undefined) {
            const suggestions = catalog
              .map(e => ({ entry: e, score: scoreModelEntry(e, `${parsed.provider} ${parsed.model}`) }))
              .filter(x => x.score > 0)
              .sort((a, b) => b.score - a.score)
              .slice(0, 5)
              .map(x => formatModelPointer(x.entry.provider, x.entry.model))
            return {
              valid: false,
              provider: parsed.provider,
              model: parsed.model,
              ...(parsed.reasoningEffort ? { reasoningEffort: parsed.reasoningEffort } : {}),
              error: `Model "${parsed.model}" on provider "${parsed.provider}" is not currently available in DSH.`,
              ...(suggestions.length > 0 ? { suggestions } : {}),
            }
          }

          const supportedEfforts = match.efforts.map(e => e.id)
          const effortValid = parsed.reasoningEffort === undefined
            || supportedEfforts.length === 0
            || supportedEfforts.includes(parsed.reasoningEffort)

          return {
            valid: effortValid,
            pointer: formatModelPointer(match.provider, match.model, parsed.reasoningEffort),
            provider: match.provider,
            providerName: match.providerName,
            model: match.model,
            modelName: match.modelName,
            reasoningEffort: parsed.reasoningEffort ?? match.defaultEffort,
            ...(match.defaultEffort !== undefined ? { defaultEffort: match.defaultEffort } : {}),
            supportedEfforts,
            ...(!effortValid ? { error: `Reasoning effort "${parsed.reasoningEffort}" is not advertised for ${match.provider}/${match.model}. Supported: ${supportedEfforts.join(', ')}.` } : {}),
          }
        }

        const query = typeof args.query === 'string' ? args.query.trim() : ''
        const ranked = catalog
          .map(entry => ({ entry, score: scoreModelEntry(entry, query) }))
          .filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 50)
          .map(({ entry }) => ({
            pointer: formatModelPointer(entry.provider, entry.model),
            provider: entry.provider,
            providerName: entry.providerName,
            model: entry.model,
            modelName: entry.modelName,
            ...(entry.defaultEffort !== undefined ? { defaultEffort: entry.defaultEffort } : {}),
            supportedEfforts: entry.efforts.map(e => e.id),
          }))

        return {
          total: ranked.length,
          models: ranked,
        }
      },
    })

    toolCtx.effect(() => () => unregister(), `${PLUGIN_ID}: resolve_model_pointer tool`)
  })
}
