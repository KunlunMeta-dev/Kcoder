
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
  // Electron's target-bound directory picker is separate from the removed
  // native file/path reader. A Gateway connection does not provide that reader.
  return false
}

export const openNativeWorkspacePathPicker: (
  initialDirectory?: string,
  options?: NativeWorkspacePathPickerOptions
) => Promise<NativeWorkspacePath[]> = async () => {
  throw new Error('Native file path selection is unavailable; use server-side browsing or file upload')
}
