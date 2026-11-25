import type { ModelPointerRemoteLike } from './catalog.ts'
import type {
  CommandContributionLike,
  ComposerInputLike,
  PopupControllerLike,
} from './command.ts'
import { MODEL_POINTER_REF_SOURCE, PLUGIN_ID } from '../shared/pointer.ts'
import { ModelPointerCatalog } from './catalog.ts'
import { createModelPointerCommand } from './command.ts'

interface CommandUiServiceLike {
  register: (contribution: CommandContributionLike) => () => void
  popupFor: (actx: unknown) => PopupControllerLike
}

interface InputTriggersServiceLike {
  registerSource: (source: {
    readonly trigger: '@' | '/'
    readonly name: string
    readonly showGroupTitle?: boolean
    candidates: () => Promise<readonly never[]>
    onPick: () => undefined
    readonly codec: {
      clipboardText: (ref: string) => string
      serialize: (ref: string, signal: AbortSignal) => Promise<string>
    }
  }) => () => void
}

interface SessionsServiceLike {
  scope: (sessionId: string) => unknown | undefined
}

interface ConversationServiceLike {
  readonly input: {
    for: (actx: unknown) => ComposerInputLike | undefined
  }
}

interface ClientContextLike {
  get: (key: string) => unknown
  effect: (fn: () => (() => void) | void, label?: string) => void
  on?: (event: string, listener: (...args: unknown[]) => void) => () => void
}

export const name = PLUGIN_ID

export const inject = ['commandUi', 'inputTriggers', 'sessions', 'conversation', 'remote', 'remote.session']

export function apply(ctx: ClientContextLike): void {
  const catalog = new ModelPointerCatalog(() => ctx.get('remote') as ModelPointerRemoteLike | undefined)
  const remote = ctx.get('remote') as ModelPointerRemoteLike | undefined
  const unsubs: Array<() => void> = []

  if (typeof remote?.$on === 'function') {
    unsubs.push(remote.$on('llm/adapters-updated', () => catalog.invalidate()))
    unsubs.push(remote.$on('llm/models-updated', () => catalog.invalidate()))
    unsubs.push(remote.$on('settings/document-updated', () => catalog.invalidate()))
    unsubs.push(remote.$on('credentials/record-updated', () => catalog.invalidate()))
    unsubs.push(remote.$on('credentials/reference-updated', () => catalog.invalidate()))
  }
  if (typeof ctx.on === 'function')
    unsubs.push(ctx.on('connection/reset', () => catalog.invalidate()))

  ctx.effect(() => () => {
    for (const off of unsubs)
      off()
    catalog.invalidate()
  }, `${PLUGIN_ID}: catalog subscriptions`)

  // Register a silent, zero-candidate ReferenceCodec so atomic `@` chips inserted
  // by `/model-pointer` serialize cleanly to `@model[provider/model@effort]` on send
  // without adding any `@` menu rows or file/folder search overhead.
  const inputTriggers = ctx.get('inputTriggers') as InputTriggersServiceLike | undefined
  let chipCodecRegistered = false
  if (typeof inputTriggers?.registerSource === 'function') {
    ctx.effect(() => {
      const dispose = inputTriggers.registerSource({
        trigger: '@',
        name: MODEL_POINTER_REF_SOURCE,
        showGroupTitle: false,
        candidates: () => Promise.resolve([]),
        onPick: () => undefined,
        codec: {
          clipboardText: ref => ref,
          serialize: async ref => ref,
        },
      })
      chipCodecRegistered = true
      return () => {
        chipCodecRegistered = false
        dispose()
      }
    }, `${PLUGIN_ID}: reference chip codec`)
  }

  const commandUi = ctx.get('commandUi') as CommandUiServiceLike | undefined
  if (typeof commandUi?.register !== 'function')
    return

  const contribution = createModelPointerCommand({
    catalog,
    canInsertChip: () => chipCodecRegistered,
    getPopup(sessionId) {
      const sessions = ctx.get('sessions') as SessionsServiceLike | undefined
      const actx = sessions?.scope(sessionId)
      if (actx === undefined)
        return undefined
      try {
        return commandUi.popupFor(actx)
      }
      catch {
        return undefined
      }
    },
    getComposerInput(sessionId) {
      const sessions = ctx.get('sessions') as SessionsServiceLike | undefined
      const conversation = ctx.get('conversation') as ConversationServiceLike | undefined
      const actx = sessions?.scope(sessionId)
      if (actx === undefined || !conversation?.input)
        return undefined
      try {
        return conversation.input.for(actx)
      }
      catch {
        return undefined
      }
    },
  })

  ctx.effect(() => commandUi.register(contribution), `${PLUGIN_ID}: /model-pointer command`)
}
