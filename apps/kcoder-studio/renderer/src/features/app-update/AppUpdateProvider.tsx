import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  checkForStudioUpdate,
  installPendingStudioUpdate,
  type StudioUpdateDownloadProgress,
  type StudioUpdateInfo,
} from '@/lib/app-updater'
import { isAppUpdateSupported } from '@/lib/app-updater'
import {
  APP_UPDATE_AUTO_CHECK_MIN_AGE_MS,
  APP_UPDATE_INITIAL_CHECK_DELAY_MS,
  APP_UPDATE_LAST_AUTO_CHECK_KEY,
  APP_UPDATE_SIMULATE_EVENT,
  APP_UPDATE_TIMER_INTERVAL_MS,
  AppUpdateContext,
  type AppUpdateContextValue,
  type AppUpdateStatus,
} from './app-update-context'

const SIMULATED_UPDATE_VERSION = 'debug-simulation'
const SIMULATED_DOWNLOAD_TOTAL_BYTES = 10_000_000
const SIMULATED_DOWNLOAD_STEP_BYTES = 1_000_000
const SIMULATED_DOWNLOAD_INTERVAL_MS = 250

const LEGACY_APP_UPDATE_LAST_AUTO_CHECK_KEY = 'wework:lastAutoUpdateCheckAt'

function readLastAutoCheckAt(): number {
  const raw =
    window.localStorage.getItem(APP_UPDATE_LAST_AUTO_CHECK_KEY) ??
    window.localStorage.getItem(LEGACY_APP_UPDATE_LAST_AUTO_CHECK_KEY)
  const value = Number(raw)
  return Number.isFinite(value) ? value : 0
}

function writeLastAutoCheckAt(value: number) {
  window.localStorage.setItem(APP_UPDATE_LAST_AUTO_CHECK_KEY, String(value))
}

function shouldAutoCheck(now: number): boolean {
  return now - readLastAutoCheckAt() >= APP_UPDATE_AUTO_CHECK_MIN_AGE_MS
}

function messageFor(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Failed to check for updates'
}

export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const supported = isAppUpdateSupported()
  const [availableUpdate, setAvailableUpdate] = useState<StudioUpdateInfo | null>(null)
  const [status, setStatus] = useState<AppUpdateStatus>('idle')
  const [downloadProgress, setDownloadProgress] = useState<StudioUpdateDownloadProgress | null>(
    null
  )
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const checkInFlightRef = useRef(false)
  const simulationTimerRef = useRef<number | null>(null)

  const clearSimulationTimer = useCallback(() => {
    if (simulationTimerRef.current === null) return
    window.clearInterval(simulationTimerRef.current)
    simulationTimerRef.current = null
  }, [])

  const runCheck = useCallback(
    async ({ silent }: { silent: boolean }): Promise<StudioUpdateInfo | null> => {
      if (!supported) return null
      if (checkInFlightRef.current || status === 'installing') {
        return availableUpdate
      }

      checkInFlightRef.current = true
      if (!silent) {
        setStatus('checking')
        setMessage(null)
        setError(null)
      }

      try {
        const update = await checkForStudioUpdate()
        setAvailableUpdate(update)

        if (update) {
          setStatus('available')
          setMessage(null)
          setError(null)
        } else if (!silent) {
          setStatus('upToDate')
          setMessage('upToDate')
          setError(null)
        }

        return update
      } catch (caughtError) {
        if (!silent) {
          setStatus('error')
          setMessage(null)
          setError(messageFor(caughtError))
        }
        return null
      } finally {
        checkInFlightRef.current = false
      }
    },
    [availableUpdate, status, supported]
  )

  const checkNow = useCallback(() => runCheck({ silent: false }), [runCheck])

  const installUpdate = useCallback(async () => {
    if (!supported || !availableUpdate || status === 'installing') return

    setStatus('installing')
    setDownloadProgress({ downloadedBytes: 0, totalBytes: null })
    setMessage(null)
    setError(null)

    try {
      await installPendingStudioUpdate(setDownloadProgress)
    } catch (caughtError) {
      const installError = messageFor(caughtError)
      setDownloadProgress(null)
      setError(installError)

      try {
        const refreshedUpdate = await checkForStudioUpdate()
        setAvailableUpdate(refreshedUpdate)
        setStatus(refreshedUpdate ? 'available' : 'error')
      } catch {
        setStatus('error')
      }
    }
  }, [availableUpdate, status, supported])

  const dismissError = useCallback(() => {
    setError(null)
    setStatus(value => (value === 'error' ? 'idle' : value))
  }, [])

  const simulateUpdate = useCallback(() => {
    if (!supported) return
    clearSimulationTimer()
    setAvailableUpdate({
      currentVersion: __KCODER_STUDIO_APP_VERSION__,
      version: SIMULATED_UPDATE_VERSION,
    })
    setStatus('installing')
    setDownloadProgress({ downloadedBytes: 0, totalBytes: SIMULATED_DOWNLOAD_TOTAL_BYTES })
    setMessage(null)
    setError(null)

    let downloadedBytes = 0
    simulationTimerRef.current = window.setInterval(() => {
      downloadedBytes = Math.min(
        downloadedBytes + SIMULATED_DOWNLOAD_STEP_BYTES,
        SIMULATED_DOWNLOAD_TOTAL_BYTES
      )
      setDownloadProgress({ downloadedBytes, totalBytes: SIMULATED_DOWNLOAD_TOTAL_BYTES })

      if (downloadedBytes === SIMULATED_DOWNLOAD_TOTAL_BYTES) {
        clearSimulationTimer()
        setAvailableUpdate(null)
        setStatus('upToDate')
        setMessage('upToDate')
      }
    }, SIMULATED_DOWNLOAD_INTERVAL_MS)
  }, [clearSimulationTimer, supported])

  useEffect(() => {
    window.addEventListener(APP_UPDATE_SIMULATE_EVENT, simulateUpdate)
    return () => window.removeEventListener(APP_UPDATE_SIMULATE_EVENT, simulateUpdate)
  }, [simulateUpdate])

  useEffect(() => clearSimulationTimer, [clearSimulationTimer])

  useEffect(() => {
    if (!supported) return

    const maybeAutoCheck = () => {
      const now = Date.now()
      if (!shouldAutoCheck(now)) return

      writeLastAutoCheckAt(now)
      void runCheck({ silent: true })
    }

    const initialTimer = window.setTimeout(maybeAutoCheck, APP_UPDATE_INITIAL_CHECK_DELAY_MS)
    const intervalTimer = window.setInterval(maybeAutoCheck, APP_UPDATE_TIMER_INTERVAL_MS)

    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(intervalTimer)
    }
  }, [runCheck, supported])

  const value = useMemo<AppUpdateContextValue>(
    () => ({
      supported,
      dismissError,
      availableUpdate,
      status,
      downloadProgress,
      message,
      error,
      checkNow,
      installUpdate,
    }),
    [
      availableUpdate,
      checkNow,
      downloadProgress,
      error,
      installUpdate,
      message,
      status,
      supported,
      dismissError,
    ]
  )

  return <AppUpdateContext.Provider value={value}>{children}</AppUpdateContext.Provider>
}
