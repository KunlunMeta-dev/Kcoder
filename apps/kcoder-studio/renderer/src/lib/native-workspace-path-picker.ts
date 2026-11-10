import { invoke } from '@/lib/runtime-commands'
import { isGatewayRuntime } from './runtime-environment'

export interface NativeWorkspacePath {
  path: string
  isDirectory: boolean
}

export interface NativeWorkspacePathPickerOptions {
  directoriesOnly?: boolean
  multiple?: boolean
  defaultToHome?: boolean
}

export function canOpenNativeWorkspacePathPicker(): boolean {
  return isGatewayRuntime()
}

export async function openNativeWorkspacePathPicker(
  initialDirectory?: string,
  options: NativeWorkspacePathPickerOptions = {}
): Promise<NativeWorkspacePath[]> {
  if (!isGatewayRuntime()) return []

  const selected = await invoke<NativeWorkspacePath[]>('pick_workspace_paths', {
    initialDirectory: initialDirectory?.trim() || null,
    directoriesOnly: options.directoriesOnly ?? false,
    multiple: options.multiple ?? true,
    defaultToHome: options.defaultToHome ?? false,
  })
  return selected.filter(item => item.path.trim().length > 0)
}
