import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { normalizeAbsoluteWorkspacePath } from '@/lib/workspace-file-path'
import { requestLocalExecutor } from '@/host/localExecutor'
import type { DeviceCommandResponse } from '@/types/api'
import { KnowledgeOperationError } from '@/features/knowledge-integration/client'
import {
  validFileSelectionDirectory,
  validFileSelectionName,
  type NativeAutomationFileInputs,
} from '@/features/knowledge-integration/automationFileInputs'

/** Reuse the current target file browser metadata; this does not grant a read or watch. */
export function nativeAutomationFileInputs(options: {
  ownerKey: string
  serverId: string
  workspacePath?: string
  isCurrent: () => boolean
  getProjectWorkspaceRoot?: (serverId: string) => Promise<string>
}): NativeAutomationFileInputs | undefined {
  if (!options.workspacePath && !options.getProjectWorkspaceRoot) return undefined
  let root = options.workspacePath
    ? normalizeAbsoluteWorkspacePath(options.workspacePath, 'AUTOMATION_FILE_WORKSPACE_UNAVAILABLE')
    : undefined
  const accountCurrent = captureAccountContextRevision()
  const check = (signal: AbortSignal) => {
    signal.throwIfAborted()
    if (!options.isCurrent() || !accountCurrent(options.serverId))
      throw new KnowledgeOperationError('KNOWLEDGE_OWNER_CHANGED')
  }
  return {
    ownerKey: options.ownerKey,
    get workspaceLabel() {
      return root ?? ''
    },
    async listDirectory({ relativeDirectory, signal }) {
      check(signal)
      if (!validFileSelectionDirectory(relativeDirectory))
        throw new KnowledgeOperationError('KNOWLEDGE_INVALID_PAYLOAD')
      try {
        if (!options.workspacePath) {
          const currentRoot = normalizeAbsoluteWorkspacePath(
            await options.getProjectWorkspaceRoot!(options.serverId),
            'AUTOMATION_FILE_WORKSPACE_UNAVAILABLE'
          )
          check(signal)
          if (root && root !== currentRoot)
            throw new KnowledgeOperationError('KNOWLEDGE_OWNER_CHANGED')
          root = currentRoot
        }
        if (!root) throw new KnowledgeOperationError('AUTOMATION_FILE_WORKSPACE_UNAVAILABLE')
        const directory =
          relativeDirectory === '.' ? root : `${root.replace(/\/$/, '')}/${relativeDirectory}`
        const response = await requestLocalExecutor<DeviceCommandResponse>(
          'device.execute_command',
          {
            deviceId: options.serverId,
            command_key: 'workspace_tree',
            workspacePath: root,
            path: directory,
            timeout_seconds: 15,
            max_output_bytes: 512 * 1024,
          },
          { signal }
        )
        if (
          !response.success ||
          !response.stdout ||
          typeof response.stdout !== 'object' ||
          Array.isArray(response.stdout)
        )
          throw new KnowledgeOperationError('AUTOMATION_FILE_DIRECTORY_UNAVAILABLE')
        const result = response.stdout as { path?: unknown; entries?: unknown[] }
        check(signal)
        if (
          typeof result.path !== 'string' ||
          normalizeAbsoluteWorkspacePath(result.path, 'invalid') !== directory ||
          !Array.isArray(result.entries)
        )
          throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT')
        const names = new Set<string>()
        const entries = result.entries.map(value => {
          if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT')
          const entry = value as Record<string, unknown>
          if (
            typeof entry.name !== 'string' ||
            !validFileSelectionName(entry.name) ||
            names.has(entry.name) ||
            typeof entry.is_directory !== 'boolean' ||
            typeof entry.size !== 'number' ||
            !Number.isSafeInteger(entry.size) ||
            entry.size < 0 ||
            typeof entry.path !== 'string' ||
            normalizeAbsoluteWorkspacePath(entry.path, 'invalid') !==
              `${directory.replace(/\/$/, '')}/${entry.name}`
          )
            throw new KnowledgeOperationError('KNOWLEDGE_INVALID_RECEIPT')
          names.add(entry.name)
          return {
            name: entry.name,
            isDirectory: entry.is_directory as boolean,
            size: entry.size as number,
          }
        })
        return entries.sort(
          (left, right) =>
            Number(right.isDirectory) - Number(left.isDirectory) ||
            left.name.localeCompare(right.name)
        )
      } catch (error) {
        if (error instanceof KnowledgeOperationError) throw error
        throw new KnowledgeOperationError('AUTOMATION_FILE_DIRECTORY_UNAVAILABLE')
      }
    },
  }
}
