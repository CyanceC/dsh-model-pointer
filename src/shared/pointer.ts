export const PLUGIN_ID = 'dsh-model-pointer'
export const COMMAND_NAME = 'model-pointer'
export const MODEL_POINTER_REF_SOURCE = PLUGIN_ID

export interface ParsedModelPointer {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface ModelEffortOption {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface ModelPointerEntry {
  readonly provider: string
  readonly providerName: string
  readonly model: string
  readonly modelName: string
  readonly description?: string
  readonly efforts: readonly ModelEffortOption[]
  readonly defaultEffort?: string
}

export interface ModelPointerGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly ModelPointerEntry[]
}

export interface ModelPointerFailure {
  readonly id: string
  readonly name: string
  readonly message: string
}

export interface ModelPointerCatalogSnapshot {
  readonly groups: readonly ModelPointerGroup[]
  readonly entries: readonly ModelPointerEntry[]
  readonly failures: readonly ModelPointerFailure[]
}

const POINTER_REGEX = /@model\[([^\s[\]]+)\]/g
const STRICT_BRACKET_POINTER = /^@model\[([^\s[\]]+)\]$/

function encodePointerPart(value: string, allowSlash: boolean): string {
  const cleaned = value.replace(/[\r\n]/g, '').trim()
  return cleaned.replace(
    allowSlash ? /[%@[\]\s]/g : /[%@[\]/\s]/g,
    ch => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  )
}

function decodePointerPart(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  }
  catch {
    return undefined
  }
}

/**
 * Format an unambiguous canonical model pointer shared by both user and agent:
 * `@model[provider/model]` or `@model[provider/model@effort]`.
 * Escapes delimiter/control characters so catalog strings cannot break out of
 * `@model[...]` or corrupt round-trip parsing.
 */
export function formatModelPointer(provider: string, model: string, reasoningEffort?: string): string {
  const p = typeof provider === 'string' ? encodePointerPart(provider, false) : ''
  const m = typeof model === 'string' ? encodePointerPart(model, true) : ''
  const e = typeof reasoningEffort === 'string' ? encodePointerPart(reasoningEffort, false) : ''
  return e ? `@model[${p}/${m}@${e}]` : `@model[${p}/${m}]`
}

/**
 * Format the compact inline chip label shown inside the composer's atomic `@` chip:
 * `Model Name` or `Model Name · Effort`.
 */
export function formatModelChipLabel(modelName: string, effortLabel?: string): string {
  const name = typeof modelName === 'string' ? modelName.replace(/[\r\n]/g, '').trim() : ''
  const effort = typeof effortLabel === 'string' ? effortLabel.replace(/[\r\n]/g, '').trim() : ''
  return effort ? `${name} · ${effort}` : name
}

/**
 * Parse a canonical `@model[provider/model@effort]` or bare `provider/model@effort` pointer.
 * Supports model IDs containing `/` (e.g. `provider-a/group/model-x@high`).
 */
export function parseModelPointer(raw: string): ParsedModelPointer | undefined {
  if (typeof raw !== 'string')
    return undefined
  let body = raw.trim()
  if (body.length === 0)
    return undefined

  if (body.startsWith('@model[')) {
    const match = STRICT_BRACKET_POINTER.exec(body)
    if (!match || !match[1])
      return undefined
    body = match[1]
  }
  else {
    if (body.startsWith('@'))
      body = body.slice(1).trim()
    if (body.length === 0 || /[\s[\]]/.test(body))
      return undefined
  }

  const slashIdx = body.indexOf('/')
  if (slashIdx <= 0 || slashIdx === body.length - 1)
    return undefined

  const rawProvider = body.slice(0, slashIdx)
  let rawModel = body.slice(slashIdx + 1)
  if (rawProvider.length === 0 || rawModel.length === 0)
    return undefined

  let rawEffort: string | undefined
  const atIdx = rawModel.lastIndexOf('@')
  if (atIdx !== -1) {
    const candidateEffort = rawModel.slice(atIdx + 1)
    const candidateModel = rawModel.slice(0, atIdx)
    if (candidateEffort.length === 0 || candidateModel.length === 0)
      return undefined
    rawEffort = candidateEffort
    rawModel = candidateModel
  }

  const provider = decodePointerPart(rawProvider)?.trim()
  const model = decodePointerPart(rawModel)?.trim()
  const reasoningEffort = rawEffort !== undefined ? decodePointerPart(rawEffort)?.trim() : undefined

  if (!provider || !model || (rawEffort !== undefined && !reasoningEffort))
    return undefined

  return {
    provider,
    model,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  }
}

/**
 * Extract all valid `@model[...]` pointers from a message string.
 */
export function extractModelPointers(text: string): ParsedModelPointer[] {
  if (typeof text !== 'string')
    return []
  const out: ParsedModelPointer[] = []
  for (const match of text.matchAll(POINTER_REGEX)) {
    const inner = match[1]
    if (!inner)
      continue
    const parsed = parseModelPointer(`@model[${inner}]`)
    if (parsed !== undefined)
      out.push(parsed)
  }
  return out
}

/**
 * Score a model entry against a space-separated query across model name/id (including
 * slash-separated segments) and provider name/id. Returns -1 when any term misses.
 */
export function scoreModelEntry(entry: ModelPointerEntry, rawQuery: string): number {
  if (typeof rawQuery !== 'string')
    return -1
  const query = rawQuery.trim().toLowerCase()
  if (query.length === 0)
    return 1

  const terms = query.split(/\s+/).filter(Boolean)
  const modelName = entry.modelName.toLowerCase()
  const modelId = entry.model.toLowerCase()
  const modelSegments = modelId.split('/').filter(Boolean)
  const providerName = entry.providerName.toLowerCase()
  const providerId = entry.provider.toLowerCase()
  const fullId = `${providerId}/${modelId}`
  const combined = `${fullId} ${providerName} ${modelName}`

  let score = 0
  for (const term of terms) {
    if (!combined.includes(term))
      return -1
    if (modelId === term || modelName === term || fullId === term)
      score += 100
    else if (modelId.startsWith(term) || modelName.startsWith(term) || fullId.startsWith(term))
      score += 65
    else if (modelSegments.some(seg => seg.startsWith(term)))
      score += 55
    else if (providerId.startsWith(term) || providerName.startsWith(term))
      score += 40
    else
      score += 15
  }
  return score
}
