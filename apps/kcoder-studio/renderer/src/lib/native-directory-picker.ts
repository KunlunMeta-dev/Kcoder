import { openNativeWorkspacePathPicker } from './native-workspace-path-picker'

export async function openNativeDirectoryPicker(defaultPath?: string): Promise<string | null> {
  const selected = await openNativeWorkspacePathPicker(defaultPath, {
    directoriesOnly: true,
    multiple: false,
  })
  return selected.find(item => item.isDirectory)?.path.trim() || null
}

export async function openNativeProjectDirectoryPicker(
  initialDirectory?: string
): Promise<string | null> {
  const selected = await openNativeWorkspacePathPicker(initialDirectory, {
    directoriesOnly: true,
    multiple: false,
    defaultToHome: true,
  })
  const directory = selected.find(item => item.isDirectory)
  return directory?.path.trim() || null
}

export async function openNativeProjectDirectoryPickers(
  initialDirectory?: string
): Promise<string[]> {
  const selected = await openNativeWorkspacePathPicker(initialDirectory, {
    directoriesOnly: true,
    multiple: true,
    defaultToHome: true,
  })
  return selected
    .filter(item => item.isDirectory)
    .map(item => item.path.trim())
    .filter(Boolean)
}
