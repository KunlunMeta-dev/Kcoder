import { isContract } from '../../../shared/generated/validator.mjs'
import type {
  OfficeAssistantDefinition,
  ToolSelectionsResult,
} from '../../../shared/generated/contracts'
import { requestLocalExecutor } from '@/host/localExecutor'
import { currentHostServer } from '@/features/runtime-target/currentHostTarget'
import { fetchGatewayServers, isKCoderGatewayPage } from './gatewayRpc'
import { hookTargetScope } from './gatewayHookConfiguration'

export type ToolSelectionMode = ToolSelectionsResult['modes'][number]['mode']

// Rebuildable UI projection only. Every editor must read the target again.
const projections = new Map<string, ToolSelectionsResult>()
export function clearToolSelectionProjections(): void {
  projections.clear()
}
export function toolSelectionProjection(scope: string): ToolSelectionsResult | undefined {
  return projections.get(scope)
}
export function projectToolSelections(scope: string, result: ToolSelectionsResult): void {
  if (projections.size >= 16 && !projections.has(scope)) projections.clear()
  projections.set(scope, result)
}
function validatedToolSelections(value: unknown): ToolSelectionsResult {
  if (!isContract('ToolSelectionsResult', value))
    throw new Error('Invalid tool selections response')
  return value as ToolSelectionsResult
}
export async function readToolSelections(
  serverId: string,
  workspacePath?: string,
  includeLunaBaseline = false,
  previewExpert?: OfficeAssistantDefinition | null
): Promise<ToolSelectionsResult> {
  const result = await requestLocalExecutor<unknown>('runtime.settings.request', {
    serverId,
    ...(workspacePath ? { workspacePath } : {}),
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
  expectedRevision: string
): Promise<ToolSelectionsResult> {
  const result = await requestLocalExecutor<unknown>('runtime.settings.request', {
    serverId,
    method: 'settings/tools/selection/save',
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
/** No sessions or writes: startup can inspect only the current local host. */
export async function syncLocalToolSelectionProjection(isCurrent: () => boolean): Promise<void> {
  if (!isKCoderGatewayPage()) return
  try {
    const target = currentHostServer(await fetchGatewayServers())
    if (!target || !isCurrent()) return
    const result = await readToolSelections(target.id)
    if (isCurrent()) projectToolSelections(hookTargetScope(target), result)
  } catch {
    /* Optional startup synchronization never blocks or interrupts startup. */
  }
}
