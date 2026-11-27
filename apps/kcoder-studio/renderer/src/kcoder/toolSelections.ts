import { isContract } from '../../../shared/generated/validator.mjs'
import type {
  OfficeAssistantDefinition,
  ToolSelectionsResult,
} from '../../../shared/generated/contracts'
import { requestLocalExecutor } from '@/host/localExecutor'

export type ToolSelectionMode = ToolSelectionsResult['modes'][number]['mode']

function validatedToolSelections(value: unknown): ToolSelectionsResult {
  if (!isContract('ToolSelectionsResult', value))
    throw new Error('Invalid tool selections response')
  return value as ToolSelectionsResult
}
export async function readToolSelections(
  serverId: string,
  options: {
    workspacePath?: string
    includeLunaBaseline?: boolean
    previewExpert?: OfficeAssistantDefinition | null
    targetScope?: string
  } = {}
): Promise<ToolSelectionsResult> {
  const { workspacePath, includeLunaBaseline, previewExpert, targetScope } = options
  const result = await requestLocalExecutor<unknown>('runtime.settings.request', {
    serverId,
    ...(workspacePath ? { workspacePath } : {}),
    ...(targetScope === undefined ? {} : { targetScope }),
    method: 'settings/tools/selection/read',
    params: {
      ...(includeLunaBaseline ? { includeLunaBaseline: true } : {}),
      ...(previewExpert !== undefined
        ? {
            includeResolution: true,
            includeExpertToolSelection: true,
            ...(previewExpert ? { previewExpert } : {}),
          }
        : {}),
    },
  })
  return validatedToolSelections(result)
}
export async function saveToolSelections(
  serverId: string,
  mode: ToolSelectionMode,
  allowedTools: string[],
  expectedRevision: string,
  expected?: { targetScope: string }
): Promise<ToolSelectionsResult> {
  const result = await requestLocalExecutor<unknown>('runtime.settings.request', {
    serverId,
    method: 'settings/tools/selection/save',
    ...(expected ? { targetScope: expected.targetScope } : {}),
    params: { mode, allowedTools, expectedRevision },
  })
  return validatedToolSelections(result)
}
/** Preserve unlisted names; a visible switch only changes its addressed tool. */
export function changedToolSelection(
  allowed: readonly string[],
  name: string,
  enabled: boolean
): string[] {
  return enabled ? [...new Set([...allowed, name])] : allowed.filter(item => item !== name)
}
