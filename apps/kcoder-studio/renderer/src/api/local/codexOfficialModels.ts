import type { ModelCatalogTarget } from '@/api/models'
import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/tauri/localExecutor'
import {
  normalizeCodexOfficialModelList,
  type CodexOfficialModelList,
} from '@/features/model-settings/codexOfficialModels'
import { runtimeMethodForCurrentHost } from '@/kcoder/legacyRuntimeAbi'

type LocalExecutorRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

export async function requestLocalCodexOfficialModels(
  request: LocalExecutorRequest = requestLocalExecutor,
  target?: ModelCatalogTarget
): Promise<CodexOfficialModelList> {
  const response = await request<unknown>(runtimeMethodForCurrentHost('modelsList'), {
    includeHidden: false,
    ...target,
  })
  return normalizeCodexOfficialModelList(response)
}

export async function getLocalCodexOfficialModels(): Promise<CodexOfficialModelList> {
  await ensureLocalExecutorStarted()
  return requestLocalCodexOfficialModels()
}
