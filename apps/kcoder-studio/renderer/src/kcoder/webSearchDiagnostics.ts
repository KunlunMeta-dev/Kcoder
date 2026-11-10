import type { WebSearchStatusReadParams, WebSearchStatusReadResult, WebSearchProbeStartParams, WebSearchProbeReadParams, WebSearchProbeResult } from '../../../shared/generated/contracts'
import { WEB_SEARCH_METHODS, validWebSearchResult } from '../../../shared/webSearchMethods.mjs'
import { requestLocalExecutor } from '@/host/localExecutor'

async function request<T>(serverId: string, method: string, params: unknown, taskId?: string): Promise<T> {
  const result = await requestLocalExecutor<unknown>('runtime.webSearch.request', { serverId, method, params, ...(taskId ? { taskId } : {}) })
  if (!validWebSearchResult(method, result)) throw new Error('SEARCH_DIAGNOSTIC_INVALID_RESULT')
  return result as T
}
export const readWebSearchStatus = (serverId: string, params: WebSearchStatusReadParams, taskId?: string) => request<WebSearchStatusReadResult>(serverId, WEB_SEARCH_METHODS.status, params, taskId)
export const startWebSearchProbe = (serverId: string, params: WebSearchProbeStartParams, taskId?: string) => request<WebSearchProbeResult>(serverId, WEB_SEARCH_METHODS.start, params, taskId)
export const readWebSearchProbe = (serverId: string, params: WebSearchProbeReadParams, taskId?: string) => request<WebSearchProbeResult>(serverId, WEB_SEARCH_METHODS.read, params, taskId)
export const cancelWebSearchProbe = (serverId: string, params: WebSearchProbeReadParams, taskId?: string) => request<WebSearchProbeResult>(serverId, WEB_SEARCH_METHODS.cancel, params, taskId)
