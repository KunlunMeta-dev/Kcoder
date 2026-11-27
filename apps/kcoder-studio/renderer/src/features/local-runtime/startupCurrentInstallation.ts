import { GatewayRpcError } from '@/kcoder/gatewayRpc'
import { getRuntimeConfig, joinAppPath } from '@/config/runtime'
const gatewayPath = (path: string) => joinAppPath(getRuntimeConfig().appBasePath, path)

export interface CurrentInstallationReceipt { serverId: string; sourcePreserved: true; originalServerId?: string; alreadyImported?: boolean }
export interface CurrentInstallationPreview {
  token: string
  sourceId: string
  sourceLabel: string
  targetId: string
  command: string
  publicationState: 'ready' | 'publishing' | 'complete' | 'unknown'
  receipt?: CurrentInstallationReceipt
}
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
// C0 controls and DEL are rejected in displayed commands.
const hasControlCharacter = (value: string) => Array.from(value).some(character => {
  const code = character.codePointAt(0) ?? 0
  return code <= 0x1f || code === 0x7f
})
function parseReceipt(value: unknown): CurrentInstallationReceipt | null {
  const data = object(value)
  if (!data || !id(data.serverId) || data.sourcePreserved !== true || (data.originalServerId !== undefined && !id(data.originalServerId))) return null
  return { serverId: data.serverId, sourcePreserved: true,
    ...(typeof data.originalServerId === 'string' ? { originalServerId: data.originalServerId } : {}),
    ...(data.alreadyImported === true ? { alreadyImported: true } : {}) }
}
async function json(response: Response): Promise<Record<string, unknown>> {
  let body: unknown
  try { body = await response.json() } catch { throw new GatewayRpcError('Invalid startup recovery response', -1, undefined, 'save-target', 'invalid-response') }
  const data = object(body)
  if (!data) throw new GatewayRpcError('Invalid startup recovery response', -1, undefined, 'save-target', 'invalid-response')
  if (!response.ok) throw new GatewayRpcError(typeof data.error === 'string' && /^(?:STARTUP_RECOVERY_[A-Z_]+|CONFIG_FILE_PUBLISH_UNCONFIRMED)$/.test(data.error) ? data.error : 'STARTUP_RECOVERY_FAILED', response.status, data.code === 'CONFIG_FILE_PUBLISH_UNCONFIRMED' ? { code: 'CONFIG_FILE_PUBLISH_UNCONFIRMED', externalOutcome: 'unknown' } : undefined, 'save-target', 'remote')
  return data
}
export async function readCurrentInstallation(sourceId: string, signal: AbortSignal): Promise<CurrentInstallationPreview | null> {
  if (!id(sourceId)) return null
  const data = await json(await fetch(gatewayPath(`/api/startup/current-installation?${new URLSearchParams({ source: sourceId })}`), { cache: 'no-store', signal }))
  if (data.available === false) return null
  const preview = object(data.preview)
  const observedReceipt = preview?.receipt === undefined ? undefined : parseReceipt(preview.receipt)
  if (data.available !== true || !preview || typeof preview.token !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(preview.token) ||
      !id(preview.sourceId) || !id(preview.targetId) || preview.sourceId !== sourceId ||
      preview.keepsOriginalConnection !== true || preview.usesCurrentAccountConfiguration !== true ||
      typeof preview.sourceLabel !== 'string' || !preview.sourceLabel.trim() || preview.sourceLabel.length > 80 ||
      typeof preview.command !== 'string' || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(preview.command) || preview.command.length > 2048 || hasControlCharacter(preview.command) ||
      !['ready', 'publishing', 'complete', 'unknown'].includes(String(preview.publicationState)) ||
      (preview.publicationState === 'complete' && !observedReceipt) ||
      (preview.receipt !== undefined && (!observedReceipt || observedReceipt.serverId !== preview.targetId))) throw new GatewayRpcError('Invalid startup recovery response', -1, undefined, 'save-target', 'invalid-response')
  return { token: preview.token, sourceId, sourceLabel: preview.sourceLabel, targetId: preview.targetId,
    command: preview.command, publicationState: preview.publicationState as CurrentInstallationPreview['publicationState'],
    ...(observedReceipt ? { receipt: observedReceipt } : {}) }
}
export async function importCurrentInstallation(preview: CurrentInstallationPreview, label: string): Promise<CurrentInstallationReceipt> {
  let response: Response
  try {
    response = await fetch(gatewayPath('/api/startup/current-installation'), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: preview.token, label }) })
  } catch {
    throw new GatewayRpcError('CONFIG_FILE_PUBLISH_UNCONFIRMED', -1, { code: 'CONFIG_FILE_PUBLISH_UNCONFIRMED', externalOutcome: 'unknown' }, 'save-target', 'unknown')
  }
  const result = await json(response)
  const observed = parseReceipt(result)
  if (!observed || observed.serverId !== preview.targetId) throw new GatewayRpcError('CONFIG_FILE_PUBLISH_UNCONFIRMED', -1, { code: 'CONFIG_FILE_PUBLISH_UNCONFIRMED', externalOutcome: 'unknown' }, 'save-target', 'invalid-response')
  return observed
}
