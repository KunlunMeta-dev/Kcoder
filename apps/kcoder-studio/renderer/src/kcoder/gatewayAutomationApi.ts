import { requestLocalExecutor } from '@/tauri/localExecutor'
import type { RuntimeWorkListResponse } from '@/types/api'

export interface AutomationProjectAddress {
  deviceId: string
  workspacePath: string
}

export interface ScheduledJob {
  id: string
  prompt: string
  next_run_at: string
  last_fired_at: string | null
  schedule:
    | { kind: 'at'; at: string }
    | { kind: 'every'; every_seconds: number }
    | { kind: 'cron'; expression: string }
    | { kind: 'zoned_cron'; expression: string; timezone: string }
}

export function automationTargets(
  work: RuntimeWorkListResponse | null,
  currentComputerLabel?: string
) {
  const targets = new Map<
    string,
    { key: string; label: string; address: AutomationProjectAddress }
  >()
  for (const workspace of [
    ...(work?.chats ?? []),
    ...(work?.projects ?? []).flatMap(project => project.deviceWorkspaces),
  ]) {
    if (workspace.workspacePath && workspace.available !== false) {
      const key = `${workspace.deviceId}\0${workspace.workspacePath}`
      targets.set(key, {
        key,
        label: `${workspace.labelKey === 'currentComputer' && currentComputerLabel ? currentComputerLabel : workspace.label || workspace.workspacePath} · ${workspace.deviceId}`,
        address: {
          deviceId: workspace.deviceId,
          workspacePath: workspace.workspacePath,
        },
      })
    }
  }
  return [...targets.values()]
}

export async function requestAutomation<T>(
  address: AutomationProjectAddress,
  method: 'cron/list' | 'cron/create' | 'cron/delete' | 'cron/preview',
  params: Record<string, unknown> = {}
): Promise<T> {
  return requestLocalExecutor('runtime.automations.request', {
    address,
    deviceId: address.deviceId,
    method,
    params,
  }) as Promise<T>
}
