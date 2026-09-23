import type { ModelCatalogTarget } from '@/api/models'
import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/tauri/localExecutor'
import {
  normalizeCodexOfficialModelList,
  type CodexOfficialModelList,
} from '@/features/model-settings/codexOfficialModels'
import { runtimeMethodForCurrentHost } from '@/kcoder/legacyRuntimeAbi'

type LocalExecutorRequest = <T>(method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<T>

export async function requestLocalCodexOfficialModels(
  request: LocalExecutorRequest = requestLocalExecutor,
  target?: ModelCatalogTarget,
  options?: { signal?: AbortSignal }
): Promise<CodexOfficialModelList> {
  const params = {
    includeHidden: false,
    ...target,
  }
  const method = runtimeMethodForCurrentHost('modelsList')
  const response = options ? await request<unknown>(method, params, options) : await request<unknown>(method, params)
  return normalizeCodexOfficialModelList(response)
}

export async function getLocalCodexOfficialModels(): Promise<CodexOfficialModelList> {
  await ensureLocalExecutorStarted()
  return requestLocalCodexOfficialModels()
}
