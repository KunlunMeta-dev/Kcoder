export interface StudioUpdateInfo {
  currentVersion: string
  version: string
  body?: string
}

export interface StudioUpdateDownloadProgress {
  downloadedBytes: number
  totalBytes: number | null
}

// Electron packages do not yet publish a signed update feed. Keep the existing
// unsupported state until a complete Electron updater is configured.
export function isAppUpdateSupported(): boolean {
  return false
}

export async function checkForStudioUpdate(): Promise<StudioUpdateInfo | null> {
  throw new Error('Automatic updates are not available in this client.')
}

// Progress is part of the updater contract even though no download can start here.
export function installPendingStudioUpdate(
  onProgress: (progress: StudioUpdateDownloadProgress) => void
): Promise<void>
export async function installPendingStudioUpdate(): Promise<void> {
  throw new Error('No pending KCoder update is available.')
}
