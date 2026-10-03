import { isNativeTauriHost } from './runtime-environment'

export interface WeworkUpdateInfo {
  currentVersion: string
  version: string
  body?: string
}

export interface WeworkUpdateDownloadProgress {
  downloadedBytes: number
  totalBytes: number | null
}

interface PendingUpdate {
  version: string
  currentVersion: string
  body?: string
  downloadAndInstall: (
    onProgress: (progress: WeworkUpdateDownloadProgress) => void
  ) => Promise<void>
}

let pendingUpdate: PendingUpdate | null = null

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Unknown updater error'
}

export async function checkForWeworkUpdate(): Promise<WeworkUpdateInfo | null> {
  if (!isNativeTauriHost()) {
    throw new Error('Automatic updates are not available in this client.')
  }

  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update) {
      pendingUpdate = null
      return null
    }

    pendingUpdate = {
      version: update.version,
      currentVersion: update.currentVersion,
      body: update.body,
      downloadAndInstall: onProgress => {
        let downloadedBytes = 0
        let totalBytes: number | null = null

        return update.downloadAndInstall(event => {
          if (event.event === 'Started') {
            totalBytes = event.data.contentLength ?? null
          } else if (event.event === 'Progress') {
            downloadedBytes += event.data.chunkLength
          }

          onProgress({ downloadedBytes, totalBytes })
        })
      },
    }

    return {
      version: update.version,
      currentVersion: update.currentVersion,
      body: update.body,
    }
  } catch (error) {
    pendingUpdate = null
    throw new Error(errorMessage(error), { cause: error })
  }
}

export async function installPendingWeworkUpdate(
  onProgress: (progress: WeworkUpdateDownloadProgress) => void
): Promise<void> {
  if (!pendingUpdate) {
    throw new Error('No pending KCoder update is available.')
  }

  try {
    await pendingUpdate.downloadAndInstall(onProgress)
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  } catch (error) {
    pendingUpdate = null
    throw new Error(errorMessage(error), { cause: error })
  }
}
