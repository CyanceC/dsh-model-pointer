import type {
  ModelEffortOption,
  ModelPointerCatalogSnapshot,
  ModelPointerEntry,
  ModelPointerFailure,
  ModelPointerGroup,
} from '../shared/pointer.ts'

export interface RemoteResultLike<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly code?: string, readonly message?: string }
}

export interface RemoteModelCatalogLike {
  readonly groups: readonly {
    readonly id: string
    readonly name: string
    readonly models: readonly {
      readonly id: string
      readonly name: string
      readonly description?: string
      readonly reasoning?: {
        readonly efforts: readonly ModelEffortOption[]
        readonly defaultEffort?: string
      }
    }[]
  }[]
  readonly failures?: readonly {
    readonly id: string
    readonly name: string
    readonly message: string
  }[]
}

export interface ModelPointerRemoteLike {
  readonly session?: {
    modelCatalog?: () => Promise<RemoteResultLike<RemoteModelCatalogLike>>
  }
  readonly $on?: (event: string, listener: (...args: unknown[]) => void) => () => void
}

const EMPTY_SNAPSHOT: ModelPointerCatalogSnapshot = {
  groups: [],
  entries: [],
  failures: [],
}

/**
 * Shared Host-generation catalog cache for the browser half.
 * Reads directly from `remote.session.modelCatalog()` — the exact same
 * Host-generation catalog used by DSH's built-in `/model` picker.
 */
export class ModelPointerCatalog {
  private snapshot: ModelPointerCatalogSnapshot | undefined
  private inflight: Promise<ModelPointerCatalogSnapshot> | undefined
  private generation = 0

  constructor(private readonly getRemote: () => ModelPointerRemoteLike | undefined) {}

  invalidate(): void {
    this.generation += 1
    this.snapshot = undefined
    this.inflight = undefined
  }

  peek(): ModelPointerCatalogSnapshot {
    return this.snapshot ?? EMPTY_SNAPSHOT
  }

  async load(): Promise<ModelPointerCatalogSnapshot> {
    if (this.snapshot !== undefined)
      return this.snapshot
    if (this.inflight !== undefined)
      return this.inflight

    const gen = this.generation
    const remote = this.getRemote()
    if (typeof remote?.session?.modelCatalog !== 'function')
      return EMPTY_SNAPSHOT

    const op = (async (): Promise<ModelPointerCatalogSnapshot> => {
      const catalogRes = await remote.session!.modelCatalog!()
      if (!catalogRes.ok) {
        const code = catalogRes.error?.code ?? 'catalog/error'
        const msg = catalogRes.error?.message ?? 'Failed to load model catalog'
        throw new Error(`${code}: ${msg}`)
      }
      if (!catalogRes.value || !Array.isArray(catalogRes.value.groups))
        return EMPTY_SNAPSHOT

      const groups: ModelPointerGroup[] = []
      const entries: ModelPointerEntry[] = []

      for (const group of catalogRes.value.groups) {
        if (!group || typeof group !== 'object' || typeof group.id !== 'string' || !Array.isArray(group.models))
          continue
        const providerName = typeof group.name === 'string' && group.name.trim().length > 0
          ? group.name.trim()
          : group.id
        const groupModels: ModelPointerEntry[] = []
        for (const model of group.models) {
          if (!model || typeof model !== 'object' || typeof model.id !== 'string' || model.id.trim().length === 0)
            continue
          const rawEfforts = Array.isArray(model.reasoning?.efforts) ? model.reasoning.efforts : []
          const efforts: ModelEffortOption[] = []
          for (const eff of rawEfforts) {
            if (!eff || typeof eff !== 'object' || typeof eff.id !== 'string' || eff.id.trim().length === 0)
              continue
            efforts.push({
              id: eff.id.trim(),
              name: typeof eff.name === 'string' && eff.name.trim().length > 0 ? eff.name.trim() : eff.id.trim(),
              ...(typeof eff.description === 'string' && eff.description.trim().length > 0 ? { description: eff.description.trim() } : {}),
            })
          }
          const entry: ModelPointerEntry = {
            provider: group.id,
            providerName,
            model: model.id,
            modelName: typeof model.name === 'string' && model.name.trim().length > 0 ? model.name.trim() : model.id,
            ...(typeof model.description === 'string' && model.description.length > 0 ? { description: model.description } : {}),
            efforts,
            ...(typeof model.reasoning?.defaultEffort === 'string' && model.reasoning.defaultEffort.trim().length > 0
              ? { defaultEffort: model.reasoning.defaultEffort.trim() }
              : {}),
          }
          groupModels.push(entry)
          entries.push(entry)
        }
        if (groupModels.length > 0) {
          groups.push({
            id: group.id,
            name: providerName,
            models: groupModels,
          })
        }
      }

      const failures: ModelPointerFailure[] = []
      if (Array.isArray(catalogRes.value.failures)) {
        for (const f of catalogRes.value.failures) {
          if (!f || typeof f !== 'object' || typeof f.id !== 'string')
            continue
          failures.push({
            id: f.id,
            name: typeof f.name === 'string' && f.name.trim().length > 0 ? f.name.trim() : f.id,
            message: typeof f.message === 'string' ? f.message : 'Failed to load provider models',
          })
        }
      }

      const next: ModelPointerCatalogSnapshot = { groups, entries, failures }
      if (gen === this.generation)
        this.snapshot = next
      return next
    })().finally(() => {
      if (gen === this.generation && this.inflight === op)
        this.inflight = undefined
    })

    this.inflight = op
    return op
  }
}
