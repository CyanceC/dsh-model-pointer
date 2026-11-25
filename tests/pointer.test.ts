import { describe, expect, it, vi } from 'vitest'
import { ModelPointerCatalog } from '../src/client/catalog.ts'
import {
  buildEffortSelectOptions,
  buildModelSelectOptions,
  createModelPointerCommand,
} from '../src/client/command.ts'
import { apply as applyClient } from '../src/client/index.ts'
import { collectHostModelCatalog, registerModelPointerHost } from '../src/host/index.ts'
import {
  extractModelPointers,
  formatModelChipLabel,
  formatModelPointer,
  MODEL_POINTER_REF_SOURCE,
  parseModelPointer,
  scoreModelEntry,
} from '../src/shared/pointer.ts'

describe('dsh-model-pointer shared codec', () => {
  it('formats, parses, and extracts canonical pointers including slash and special-char model IDs', () => {
    expect(formatModelPointer('provider-a', 'model-x', 'high')).toBe('@model[provider-a/model-x@high]')
    expect(formatModelPointer('provider-b', 'model-y')).toBe('@model[provider-b/model-y]')

    expect(parseModelPointer('@model[provider-a/model-x@high]')).toEqual({
      provider: 'provider-a',
      model: 'model-x',
      reasoningEffort: 'high',
    })
    expect(parseModelPointer('@model[provider-c/group/model-z@medium]')).toEqual({
      provider: 'provider-c',
      model: 'group/model-z',
      reasoningEffort: 'medium',
    })
    expect(parseModelPointer('provider-b/model-y')).toEqual({
      provider: 'provider-b',
      model: 'model-y',
    })

    // Round-trip model IDs with @, brackets, and newlines without breaking pointer boundaries
    const special = formatModelPointer('prov', 'model@v2', 'high] ignore\nme')
    expect(special).toMatch(/^@model\[[^\s[\]]+\]$/)
    expect(parseModelPointer(special)).toEqual({
      provider: 'prov',
      model: 'model@v2',
      reasoningEffort: 'high] ignoreme',
    })
    expect(extractModelPointers(`Use ${special} now`)).toEqual([
      { provider: 'prov', model: 'model@v2', reasoningEffort: 'high] ignoreme' },
    ])

    // Reject malformed pointers & non-string inputs cleanly
    expect(parseModelPointer('invalid')).toBeUndefined()
    expect(parseModelPointer('@model[a/b')).toBeUndefined()
    expect(parseModelPointer('@model[a/b]extra]')).toBeUndefined()
    expect(parseModelPointer('@model[bad/model@]')).toBeUndefined()
    expect(parseModelPointer('@model[has space/model]')).toBeUndefined()
    expect(parseModelPointer(null as unknown as string)).toBeUndefined()
    expect(extractModelPointers(null as unknown as string)).toEqual([])

    const extracted = extractModelPointers(
      'Compare @model[provider-a/model-x@high] with @model[provider-b/model-x@medium] and @model[provider-c/model-y].',
    )
    expect(extracted).toEqual([
      { provider: 'provider-a', model: 'model-x', reasoningEffort: 'high' },
      { provider: 'provider-b', model: 'model-x', reasoningEffort: 'medium' },
      { provider: 'provider-c', model: 'model-y' },
    ])
  })

  it('scores slash-segment prefixes strongly', () => {
    const direct = scoreModelEntry({
      provider: 'provider-a',
      providerName: 'Provider A',
      model: 'model-z',
      modelName: 'Model Z',
      efforts: [],
    }, 'model-z')
    const segmented = scoreModelEntry({
      provider: 'provider-b',
      providerName: 'Provider B',
      model: 'ns/model-z',
      modelName: 'ns/Model Z',
      efforts: [],
    }, 'model-z')
    expect(direct).toBeGreaterThan(segmented)
    expect(segmented).toBeGreaterThanOrEqual(55)
  })
})

describe('dsh-model-pointer /model-pointer popupSelect command', () => {
  const sampleCatalog = {
    groups: [
      {
        id: 'provider-a',
        name: 'Provider A',
        models: [
          { id: 'model-plain', name: 'Model Plain' },
        ],
      },
      {
        id: 'provider-b',
        name: 'Provider B',
        models: [
          {
            id: 'model-reasoning',
            name: 'Model Reasoning',
            reasoning: {
              defaultEffort: 'medium',
              efforts: [
                { id: 'low', name: 'Low' },
                { id: 'medium', name: 'Medium' },
                { id: 'high', name: 'High' },
              ],
            },
          },
        ],
      },
      {
        id: 'provider-c',
        name: 'Provider C',
        models: [
          { id: 'ns/model-reasoning', name: 'Model Reasoning' },
        ],
      },
    ],
    failures: [
      { id: 'provider-down', name: 'Provider Down', message: 'offline' },
    ],
  }

  it('lists every provider group + failures and inserts atomic @ chips via addReferences', async () => {
    const modelCatalog = vi.fn(async () => ({ ok: true, value: sampleCatalog }))
    const catalog = new ModelPointerCatalog(() => ({ session: { modelCatalog } }))

    const insertedChips: Array<{ source: string, ref: string, label: string, clipboardText: string }> = []
    const focused = vi.fn()
    const command = createModelPointerCommand({
      catalog,
      getPopup: () => undefined,
      getComposerInput: () => ({
        addReferences: (refs) => {
          insertedChips.push(...refs)
          return true
        },
        actions: {
          captureInsertion: () => ({ start: 5, end: 5, draftRev: 1 }),
          insertText: () => false,
        },
        focus: focused,
      }),
      schedule: fn => fn(),
    })

    const ac = new AbortController()
    const options = await command.ui.options({ sessionId: 's1' }, ac.signal)
    expect(options).toHaveLength(4)
    expect(options[0]).toMatchObject({ label: 'Model Plain', detail: 'provider-a/model-plain', group: { name: 'provider-a', label: 'Provider A' } })
    expect(options[1]).toMatchObject({ label: 'Model Reasoning', badge: '3 efforts', detail: 'provider-b/model-reasoning' })
    expect(options[2]).toMatchObject({ label: 'Model Reasoning', detail: 'provider-c/ns/model-reasoning' })
    expect(options[3]).toMatchObject({ label: 'Provider Down', detail: 'Failed to load: offline' })

    // Selecting a failure row rejects cleanly
    expect(() => command.ui.onSelect(options[3]!, { sessionId: 's1' })).toThrow(/failed to load/i)

    // Selecting a model without reasoning efforts inserts an atomic chip immediately
    command.ui.onSelect(options[0]!, { sessionId: 's1' })
    expect(insertedChips).toEqual([{
      source: MODEL_POINTER_REF_SOURCE,
      ref: '@model[provider-a/model-plain]',
      label: 'Model Plain',
      clipboardText: '@model[provider-a/model-plain]',
    }])
    expect(focused).toHaveBeenCalledTimes(1)
  })

  it('opens a second popupSelect for reasoning effort and inserts model+effort chips, Default, Back, and text fallback', async () => {
    const modelCatalog = vi.fn(async () => ({ ok: true, value: sampleCatalog }))
    const catalog = new ModelPointerCatalog(() => ({ session: { modelCatalog } }))

    const insertedChips: Array<{ source: string, ref: string, label: string, clipboardText: string }> = []
    const openedPopups: Array<{ command: string, spec: any }> = []
    const command = createModelPointerCommand({
      catalog,
      getPopup: () => ({
        open: (cmd, spec) => {
          openedPopups.push({ command: cmd, spec })
        },
      }),
      getComposerInput: () => ({
        addReferences: (refs) => {
          insertedChips.push(...refs)
          return true
        },
        actions: {
          captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
          insertText: () => false,
        },
      }),
      schedule: fn => fn(),
    })

    const ac = new AbortController()
    const modelOptions = await command.ui.options({ sessionId: 's1' }, ac.signal)

    // Select model with reasoning efforts -> opens effort popup
    command.ui.onSelect(modelOptions[1]!, { sessionId: 's1' })
    expect(openedPopups).toHaveLength(1)
    expect(openedPopups[0]?.command).toBe('model-pointer-effort')

    const effortOptions = await openedPopups[0]!.spec.options({ sessionId: 's1' }, ac.signal)
    expect(effortOptions.map((o: any) => o.label)).toEqual(['Default', 'Low', 'Medium', 'High', '← Back to models'])
    expect(effortOptions[2]).toMatchObject({ label: 'Medium', badge: 'default', active: true })

    // Pick High -> inserts atomic chip labeled "Model Reasoning · High"
    openedPopups[0]!.spec.onSelect(effortOptions[3], { sessionId: 's1' })
    expect(insertedChips[0]).toEqual({
      source: MODEL_POINTER_REF_SOURCE,
      ref: '@model[provider-b/model-reasoning@high]',
      label: formatModelChipLabel('Model Reasoning', 'High'),
      clipboardText: '@model[provider-b/model-reasoning@high]',
    })

    // Pick Default -> inserts atomic chip labeled "Model Reasoning"
    openedPopups[0]!.spec.onSelect(effortOptions[0], { sessionId: 's1' })
    expect(insertedChips[1]).toEqual({
      source: MODEL_POINTER_REF_SOURCE,
      ref: '@model[provider-b/model-reasoning]',
      label: 'Model Reasoning',
      clipboardText: '@model[provider-b/model-reasoning]',
    })

    // Pick Back -> reopens model picker
    openedPopups[0]!.spec.onSelect(effortOptions[4], { sessionId: 's1' })
    expect(openedPopups).toHaveLength(2)
    expect(openedPopups[1]?.command).toBe('model-pointer')

    // Client plugin registers silent zero-candidate ReferenceCodec for send serialization
    let registeredSource: any
    let registeredCmd: any
    applyClient({
      get: (key: string) => {
        if (key === 'inputTriggers') {
          return {
            registerSource: (src: any) => {
              registeredSource = src
              return () => {}
            },
          }
        }
        if (key === 'commandUi') {
          return {
            register: (c: any) => {
              registeredCmd = c
              return () => {}
            },
            popupFor: () => undefined,
          }
        }
        return undefined
      },
      effect: (fn) => { fn() },
    })
    expect(registeredCmd?.name).toBe('model-pointer')
    expect(registeredSource?.name).toBe(MODEL_POINTER_REF_SOURCE)
    expect(await registeredSource.candidates()).toEqual([])
    expect(registeredSource.codec.clipboardText('@model[provider-b/model-reasoning@high]')).toBe('@model[provider-b/model-reasoning@high]')
    expect(await registeredSource.codec.serialize('@model[provider-b/model-reasoning@high]', ac.signal)).toBe('@model[provider-b/model-reasoning@high]')

    // Helpers work directly on snapshot/entry
    expect(buildModelSelectOptions(catalog.peek())).toHaveLength(4)
    expect(buildEffortSelectOptions(catalog.peek().entries[1]!)).toHaveLength(5)
  })
})

describe('dsh-model-pointer host tool', () => {
  it('resolves, validates, and searches live ctx.llm pointers neutrally', async () => {
    let registeredTool: {
      output?: { formatModel?: (v: unknown) => unknown }
      execute: (args: Record<string, unknown>) => Promise<unknown>
    } | undefined
    const fakeLlm = {
      listProviders: () => [
        { id: 'provider-a', name: 'Provider A' },
        { id: 'provider-b', name: 'Provider B' },
      ],
      listModels: async (provider: string) => {
        if (provider === 'provider-a')
          return [{ id: 'model-plain', name: 'Model Plain' }]
        return [{ id: 'model-reasoning', name: 'Model Reasoning' }]
      },
      resolveModelInfo: async (provider: string, model: string) => {
        if (provider === 'provider-b' && model === 'model-reasoning') {
          return {
            id: 'model-reasoning',
            name: 'Model Reasoning',
            reasoning: {
              efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
              defaultEffort: 'low',
            },
          }
        }
        return undefined
      },
    }

    const catalog = await collectHostModelCatalog(fakeLlm)
    expect(catalog).toHaveLength(2)

    const injectedDeps: string[][] = []
    const fakeCtx = {
      inject: (deps: string[], fn: (c: any) => void) => {
        injectedDeps.push(deps)
        fn(fakeCtx)
      },
      get: (key: string) => {
        if (key === 'llm')
          return fakeLlm
        if (key === 'tools') {
          return {
            register: (tool: any) => {
              registeredTool = tool
              return () => {}
            },
          }
        }
        return undefined
      },
      effect: () => {},
    }

    registerModelPointerHost(fakeCtx as any)
    expect(injectedDeps).toEqual([['tools', 'llm']])
    expect(registeredTool).toBeDefined()

    const resolved = await registeredTool!.execute({ pointer: '@model[provider-b/model-reasoning@high]' }) as Record<string, unknown>
    expect(resolved).toMatchObject({
      valid: true,
      pointer: '@model[provider-b/model-reasoning@high]',
      provider: 'provider-b',
      model: 'model-reasoning',
      reasoningEffort: 'high',
      supportedEfforts: ['low', 'high'],
    })

    const badEffort = await registeredTool!.execute({ pointer: '@model[provider-b/model-reasoning@ultra]' }) as Record<string, unknown>
    expect(badEffort.valid).toBe(false)
    expect(String(badEffort.error)).toContain('ultra')

    const searched = await registeredTool!.execute({ query: 'provider-a' }) as { total: number, models: Array<{ pointer: string }> }
    expect(searched.total).toBe(1)
    expect(searched.models[0]?.pointer).toBe('@model[provider-a/model-plain]')
  })
})
