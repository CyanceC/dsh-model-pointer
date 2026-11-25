import type { Context } from '@deepseek-ai/cordis'
import { registerModelPointerHost } from './host/index.ts'
import { PLUGIN_ID } from './shared/pointer.ts'

export const name = PLUGIN_ID

export function apply(ctx: Context): void {
  registerModelPointerHost(ctx)
}

export {
  COMMAND_NAME,
  extractModelPointers,
  formatModelChipLabel,
  formatModelPointer,
  MODEL_POINTER_REF_SOURCE,
  parseModelPointer,
  PLUGIN_ID,
  scoreModelEntry,
} from './shared/pointer.ts'
export type {
  ModelEffortOption,
  ModelPointerCatalogSnapshot,
  ModelPointerEntry,
  ModelPointerFailure,
  ModelPointerGroup,
  ParsedModelPointer,
} from './shared/pointer.ts'
