import { runtimeThreadId } from '@/lib/runtime-thread-id'
import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import type { RuntimeTaskAddress } from '@/types/api'

/** Fill missing presentation facts only after the original Native read verified them. */
export function mergeResolvedRuntimeTaskAddress(
  original: RuntimeTaskAddress,
  resolved: RuntimeTaskAddress,
): RuntimeTaskAddress | null {
  if (resolved.deviceId !== original.deviceId || resolved.taskId !== original.taskId ||
      typeof resolved.threadId !== 'string' || !resolved.threadId.trim() ||
      typeof resolved.workspacePath !== 'string' || !resolved.workspacePath.trim()) return null
  const originalThread = runtimeThreadId(original)
  if (originalThread && originalThread !== resolved.threadId ||
      original.expectedSessionAddress && original.expectedSessionAddress.threadId !== resolved.threadId ||
      original.workspacePath && !sameWorkspacePath(original.workspacePath, resolved.workspacePath)) return null
  const handle = resolved.runtimeHandle
  if (handle != null && (typeof handle !== 'object' || Array.isArray(handle))) return null
  const handleThread = runtimeThreadId({ ...resolved, threadId: null })
  if (handleThread && handleThread !== resolved.threadId) return null
  const originalHandle = original.runtimeHandle ?? {}
  if (typeof originalHandle !== 'object' || Array.isArray(originalHandle)) return null
  const missing = Object.entries(handle ?? {}).filter(([key, value]) => value != null && originalHandle[key] == null)
  if (original.threadId && original.workspacePath && missing.length === 0) return original
  return {
    ...original,
    ...(!original.threadId ? { threadId: resolved.threadId } : {}),
    ...(!original.workspacePath ? { workspacePath: resolved.workspacePath } : {}),
    ...(missing.length ? { runtimeHandle: { ...originalHandle, ...Object.fromEntries(missing) } } : {}),
  }
}
