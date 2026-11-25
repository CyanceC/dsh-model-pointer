import type { ModelPointerCatalogSnapshot, ModelPointerEntry } from '../shared/pointer.ts'
import type { ModelPointerCatalog } from './catalog.ts'
import {
  COMMAND_NAME,
  formatModelChipLabel,
  formatModelPointer,
  MODEL_POINTER_REF_SOURCE,
} from '../shared/pointer.ts'

export interface ClientSessionContextLike {
  readonly sessionId: string
}

export interface SelectOptionGroupLike {
  readonly name: string
  readonly label: string
}

export interface SelectOptionLike {
  readonly id: string
  readonly label: string
  readonly badge?: string
  readonly detail?: string
  readonly group?: SelectOptionGroupLike
  readonly active?: boolean
}

export interface PopupSearchLabelsLike {
  readonly placeholder: string
  readonly empty: string
  readonly noResults: string
}

export interface PopupSelectSpecLike {
  readonly kind: 'popupSelect'
  searchLabels?: () => PopupSearchLabelsLike
  options: (session: ClientSessionContextLike, signal: AbortSignal) => Promise<readonly SelectOptionLike[]>
  onSelect: (option: SelectOptionLike, session: ClientSessionContextLike) => void | Promise<void>
}

export interface CommandContributionLike {
  readonly name: string
  label?: () => string
  description?: () => string
  available: (session: ClientSessionContextLike) => boolean
  readonly ui: PopupSelectSpecLike
}

export interface PopupControllerLike {
  open: (
    command: string,
    spec: Omit<PopupSelectSpecLike, 'kind'>,
    context: ClientSessionContextLike,
    segment: { readonly via: 'enter', readonly token: string },
  ) => void
}

export interface ReferenceInsertLike {
  readonly source: string
  readonly ref: string
  readonly label: string
  readonly clipboardText: string
}

export interface ComposerInputLike {
  readonly addReferences?: (references: readonly ReferenceInsertLike[]) => boolean
  readonly actions: {
    captureInsertion: () => unknown
    insertText: (text: string, span: unknown) => boolean
  }
  focus?: () => void
  notify?: (level: 'info' | 'error', text: string) => void
}

export interface ModelPointerCommandDeps {
  readonly catalog: ModelPointerCatalog
  readonly getPopup: (sessionId: string) => PopupControllerLike | undefined
  readonly getComposerInput: (sessionId: string) => ComposerInputLike | undefined
  /** Whether the reference-chip codec is registered with `inputTriggers`. Defaults to true. */
  readonly canInsertChip?: () => boolean
  readonly schedule?: (fn: () => void) => void
}

const FAILURE_PREFIX = 'failure:'
const EFFORT_DEFAULT_ID = 'effort:default'
const EFFORT_ITEM_PREFIX = 'effort:item:'
const NAV_BACK_ID = 'nav:back'

function modelRowId(provider: string, model: string): string {
  return `model:${JSON.stringify([provider, model])}`
}

export function buildModelSelectOptions(snapshot: ModelPointerCatalogSnapshot): SelectOptionLike[] {
  const rows: SelectOptionLike[] = []
  for (const group of snapshot.groups) {
    for (const entry of group.models) {
      const effortBadge = entry.efforts.length > 0 ? `${entry.efforts.length} efforts` : undefined
      rows.push({
        id: modelRowId(entry.provider, entry.model),
        label: entry.modelName,
        ...(effortBadge !== undefined ? { badge: effortBadge } : {}),
        detail: `${entry.provider}/${entry.model}`,
        group: { name: group.id, label: group.name },
      })
    }
  }
  for (const failure of snapshot.failures) {
    rows.push({
      id: `${FAILURE_PREFIX}${failure.id}`,
      label: failure.name,
      detail: `Failed to load: ${failure.message}`,
      group: { name: '__failures__', label: 'Unavailable providers' },
    })
  }
  return rows
}

export function buildEffortSelectOptions(entry: ModelPointerEntry): SelectOptionLike[] {
  const group: SelectOptionGroupLike = {
    name: `${entry.provider}/${entry.model}`,
    label: `${entry.providerName} · ${entry.modelName}`,
  }
  const hasMatchingDefault = entry.defaultEffort !== undefined
    && entry.efforts.some(e => e.id === entry.defaultEffort)

  const rows: SelectOptionLike[] = [
    {
      id: EFFORT_DEFAULT_ID,
      label: 'Default',
      detail: entry.defaultEffort !== undefined
        ? `Model default (${entry.defaultEffort}) · ${formatModelPointer(entry.provider, entry.model)}`
        : formatModelPointer(entry.provider, entry.model),
      group,
      ...(!hasMatchingDefault ? { active: true } : {}),
    },
  ]

  for (const eff of entry.efforts) {
    const isDefault = entry.defaultEffort === eff.id
    const pointer = formatModelPointer(entry.provider, entry.model, eff.id)
    rows.push({
      id: `${EFFORT_ITEM_PREFIX}${eff.id}`,
      label: eff.name,
      ...(isDefault ? { badge: 'default', active: true } : {}),
      detail: eff.description ? `${eff.description} · ${pointer}` : pointer,
      group,
    })
  }

  rows.push({
    id: NAV_BACK_ID,
    label: '← Back to models',
    detail: 'Choose a different model',
    group: { name: '__nav__', label: 'Navigation' },
  })

  return rows
}

function defaultSchedule(fn: () => void): void {
  setTimeout(fn, 0)
}

export function createModelPointerCommand(deps: ModelPointerCommandDeps): CommandContributionLike {
  const schedule = deps.schedule ?? defaultSchedule

  const insertPointerChip = (
    sessionId: string,
    entry: ModelPointerEntry,
    effortId?: string,
    effortLabel?: string,
  ): void => {
    const input = deps.getComposerInput(sessionId)
    if (!input)
      return

    const pointer = formatModelPointer(entry.provider, entry.model, effortId)
    const label = formatModelChipLabel(entry.modelName, effortLabel ?? effortId)
    const chipReady = deps.canInsertChip ? deps.canInsertChip() : true

    let inserted = false
    if (chipReady && typeof input.addReferences === 'function') {
      inserted = input.addReferences([{
        source: MODEL_POINTER_REF_SOURCE,
        ref: pointer,
        label,
        clipboardText: pointer,
      }])
    }
    else {
      const span = input.actions.captureInsertion()
      inserted = input.actions.insertText(`${pointer} `, span)
    }

    if (!inserted) {
      input.notify?.('error', `Could not insert model pointer "${pointer}" into the composer.`)
      return
    }
    input.focus?.()
  }

  const openEffortPicker = (session: ClientSessionContextLike, entry: ModelPointerEntry): void => {
    const popup = deps.getPopup(session.sessionId)
    if (!popup) {
      insertPointerChip(session.sessionId, entry)
      return
    }
    const effortSpec: Omit<PopupSelectSpecLike, 'kind'> = {
      searchLabels: () => ({
        placeholder: `Select reasoning effort for ${entry.modelName}…`,
        empty: 'No reasoning efforts advertised',
        noResults: 'No matching reasoning effort',
      }),
      options: async () => buildEffortSelectOptions(entry),
      onSelect: (option, currentSession) => {
        if (option.id === NAV_BACK_ID) {
          schedule(() => openModelPicker(currentSession))
          return
        }
        if (option.id === EFFORT_DEFAULT_ID) {
          schedule(() => insertPointerChip(currentSession.sessionId, entry))
          return
        }
        if (option.id.startsWith(EFFORT_ITEM_PREFIX)) {
          const effortId = option.id.slice(EFFORT_ITEM_PREFIX.length)
          const effortName = entry.efforts.find(e => e.id === effortId)?.name ?? effortId
          schedule(() => insertPointerChip(currentSession.sessionId, entry, effortId, effortName))
        }
      },
    }
    popup.open(`${COMMAND_NAME}-effort`, effortSpec, session, { via: 'enter', token: '' })
  }

  const modelSpec: PopupSelectSpecLike = {
    kind: 'popupSelect',
    searchLabels: () => ({
      placeholder: 'Search models or providers…',
      empty: 'No models available',
      noResults: 'No matching models',
    }),
    options: async (_session, signal) => {
      if (signal.aborted)
        return []
      const snapshot = await deps.catalog.load()
      if (signal.aborted)
        return []
      return buildModelSelectOptions(snapshot)
    },
    onSelect: (option, session) => {
      if (option.id.startsWith(FAILURE_PREFIX))
        throw new Error('This provider failed to load — choose a model from an available provider.')

      const entry = deps.catalog.peek().entries.find(e => modelRowId(e.provider, e.model) === option.id)
      if (!entry)
        throw new Error('Selected model is no longer in the catalog — please try again.')

      if (entry.efforts.length > 0) {
        // Defer until the current popupSelect finishes consuming `/model-pointer`
        // and closing, then open the reasoning-effort selector in the same shell.
        schedule(() => openEffortPicker(session, entry))
        return
      }

      schedule(() => insertPointerChip(session.sessionId, entry))
    },
  }

  const openModelPicker = (session: ClientSessionContextLike): void => {
    const popup = deps.getPopup(session.sessionId)
    if (!popup)
      return
    popup.open(COMMAND_NAME, modelSpec, session, { via: 'enter', token: '' })
  }

  return {
    name: COMMAND_NAME,
    label: () => 'Model Pointer',
    description: () => 'Look up any available model (with reasoning effort) and insert it into the message',
    available: () => true,
    ui: modelSpec,
  }
}
