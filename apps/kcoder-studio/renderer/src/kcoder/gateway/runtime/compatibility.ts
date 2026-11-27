import {
  isKCoderRuntimeMethod,
  KCODER_RUNTIME_METHODS,
  type KCoderRuntimeMethodKey,
} from '../../legacyRuntimeAbi'
import { record, text } from './contracts'

/** Only historical entry-point differences live here, never connections or caches. */
export interface GatewayRuntimeCompatibility {
  isRuntimeTaskId(value: string | null | undefined): boolean
  matchesMethod(method: string, key: KCoderRuntimeMethodKey): boolean
  executionProxyUrl(execution: Record<string, unknown>): string | null
  commandWorkspace(requested: string | undefined, fallback: string | undefined): string | undefined
  fileWorkspace(params: Record<string, unknown>): string | undefined
  skillsWorkspace(params: Record<string, unknown>): string | undefined
  searchWorkspace(params: Record<string, unknown>): string | undefined
  hydratedRunning(serverStatus: unknown, locallyActive: boolean): boolean
}

function proxyUrl(execution: Record<string, unknown>, acceptKCoder: boolean): string | null {
  const model = record(execution.model_config)
  if (Object.keys(model).length === 0) return null
  const runtime = record(model.runtime_config)
  const native = record(runtime.kcoder)
  const config = acceptKCoder && Object.keys(native).length > 0 ? native : record(runtime.codex)
  return config.use_proxy === true ? (text(record(model.proxy).url) ?? '') : ''
}

export const standaloneCompatibility: GatewayRuntimeCompatibility = {
  isRuntimeTaskId: value =>
    Boolean(value && (value.startsWith('kcoder:') || value.startsWith('codex:'))),
  matchesMethod: (method, key) => method === KCODER_RUNTIME_METHODS[key],
  executionProxyUrl: execution => proxyUrl(execution, false),
  commandWorkspace: (requested, fallback) => requested ?? fallback,
  fileWorkspace: params => text(params.path) ?? text(params.workspacePath) ?? undefined,
  skillsWorkspace: params => text(params.path) ?? text(params.workspacePath) ?? undefined,
  searchWorkspace: () => undefined,
  hydratedRunning: status => status === 'running',
}

export const installedCompatibility: GatewayRuntimeCompatibility = {
  isRuntimeTaskId: value => Boolean(value?.startsWith('kcoder:')),
  matchesMethod: isKCoderRuntimeMethod,
  executionProxyUrl: execution => proxyUrl(execution, true),
  commandWorkspace: (requested, fallback) => requested?.trim() || fallback,
  fileWorkspace: params =>
    text(params.path) ?? text(params.cwd) ?? text(params.workspacePath) ?? undefined,
  skillsWorkspace: () => undefined,
  searchWorkspace: params =>
    text(params.root) ?? text(params.workspacePath) ?? text(params.path) ?? undefined,
  // A persisted running lease is not necessarily an active renderer turn.
  hydratedRunning: (_status, locallyActive) => locallyActive,
}
