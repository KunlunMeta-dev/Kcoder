import i18n from '@/i18n'
import {
  normalizeWorkspaceChunkRevision,
  workspaceBinaryRevisionUnavailableError,
} from '@/lib/workspace-file-chunk-revision'
import { hookTargetScope } from './gatewayHookConfiguration'
import { record } from './gateway/runtime/contracts'
import type { GatewayRuntimeCore } from './gateway/runtime/core'
import type { GatewayServer } from './gatewayRpc'

export async function readWorkspaceFileChunk(
  this: GatewayRuntimeCore,
  server: GatewayServer,
  params: Record<string, unknown>
) {
  const scope = hookTargetScope(server)
  const workspace = this.compatibility.fileWorkspace(params)
  const client = await this.commandClient(server, workspace)
  const assertCurrent = async () => {
    const current = await this.serverForParams({ deviceId: server.id })
    if (
      this.disposed ||
      hookTargetScope(current) !== scope ||
      (await this.commandClient(current, workspace)) !== client
    )
      throw new Error(i18n.t('common:workbench.workspace_file_target_changed'))
  }
  await assertCurrent()
  if (client.supportsExperimental?.('workspaceFiles') === false)
    throw new Error('KCoder app-server does not support workspace file access')
  const supported = client.supportsExperimental?.('workspaceBinaryRevisionV1') === true
  const expected = params.expected_revision
  if (expected !== undefined && (typeof expected !== 'string' || !expected.trim()))
    throw new Error('Invalid expected workspace file revision')
  if (expected !== undefined && !supported) throw workspaceBinaryRevisionUnavailableError()
  const result = record(await client.request('device/execute', params))
  await assertCurrent()
  if (result.success !== true) return result
  const stdout: Record<string, unknown> = {
    ...record(result.stdout),
    revision_supported: supported,
  }
  const normalized = normalizeWorkspaceChunkRevision(stdout, expected)
  // Do not expose an unnegotiated opaque token to subsequent reads.
  delete stdout.revision
  return { ...result, stdout: { ...stdout, ...normalized } }
}
