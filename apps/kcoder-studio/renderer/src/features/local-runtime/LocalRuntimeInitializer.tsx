import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertCircle, Check, Copy, RefreshCw } from 'lucide-react'
import {
  StartupBrand,
  StartupIllustration,
  StartupSignature,
  StartupSteps,
  StartupWordmark,
} from './StartupScene'
import { Button } from '@/components/ui/button'
import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import { getRuntimeConfig } from '@/config/runtime'
import {
  applyLocalExecutorCloudConnection,
  type LocalExecutorCloudConnection,
} from '@/features/cloud-connection/localExecutorCloudConnection'
import { useTranslation } from '@/hooks/useTranslation'
import { isLocalFirstAppRuntime } from '@/lib/runtime-mode'
import { KCoderAccountStartup } from '@/kcoder/KCoderAccountStartup'
import {
  copyLocalExecutorDebugInfo,
  ensureLocalExecutorStarted,
  readLocalExecutorLog,
  type LocalExecutorLog,
  type LocalExecutorStatus,
} from '@/host/localExecutor'

const LOCAL_RUNTIME_SLOW_STARTUP_MS = 10000

type LocalRuntimePhase = 'starting' | 'ready' | 'failed' | 'account-login'
type CopyDebugState = 'idle' | 'copying' | 'copied' | 'failed'

interface LocalRuntimeInitializerProps {
  children: ReactNode
  initialCloudConnection?: LocalExecutorCloudConnection
  startupReady?: boolean
  waitForInitialPage?: boolean
}

interface LocalRuntimeState {
  phase: LocalRuntimePhase
  error: string | null
}

interface LocalRuntimeErrorText {
  notRunning: string
  notReady: string
}

interface LocalRuntimeDebugInfo {
  capturedAt: string
  runtimeMode: string
  phase: LocalRuntimePhase
  startupReady: boolean
  ensureCallState: string
  error: string | null
  log: LocalExecutorLog | null
  logError: string | null
}

function shouldInitializeLocalRuntime(): boolean {
  return isLocalFirstAppRuntime()
}

function localRuntimeError(
  status: LocalExecutorStatus,
  errorText: LocalRuntimeErrorText
): string | null {
  if (status.error) return status.error
  if (!status.running) return errorText.notRunning
  if (status.ready === false) return errorText.notReady
  return null
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : String(error || fallback)
}

function sanitizeLocalRuntimeDebugText(text: string): string {
  return text.replace(/\bsidecar\b/gi, 'executor process')
}

async function resolveLocalRuntimeState(
  fallbackError: string,
  errorText: LocalRuntimeErrorText
): Promise<LocalRuntimeState> {
  try {
    const status = await ensureLocalExecutorStarted()
    if (status.accountLoginServerId && status.running && status.ready === false) {
      return { phase: 'account-login', error: null }
    }
    const statusError = localRuntimeError(status, errorText)
    if (statusError) {
      throw new Error(statusError)
    }
    return { phase: 'ready', error: null }
  } catch (error) {
    return {
      phase: 'failed',
      error: errorMessage(error, fallbackError),
    }
  }
}

function formatLocalRuntimeDebugInfo(info: LocalRuntimeDebugInfo): string {
  const logPath = info.log?.path?.trim()
  const logContent = info.logError
    ? `Failed to read executor log: ${info.logError}`
    : info.log?.content || '(executor log is empty)'

  const debugText = [
    'KCoder Studio startup debug',
    `Captured at: ${info.capturedAt}`,
    `App mode: ${info.runtimeMode}`,
    `Startup phase: ${info.phase}`,
    `Startup ready: ${info.startupReady ? 'true' : 'false'}`,
    `Startup check: ${info.ensureCallState}`,
    `Error: ${info.error ?? 'none'}`,
    `IPC transport: ${info.log?.transport ?? 'unknown'}`,
    `IPC connected: ${info.log ? String(info.log.transportConnected) : 'unknown'}`,
    `Executor PID(s): ${info.log?.processPids.length ? info.log.processPids.join(', ') : 'none'}`,
    `Executor process path(s): ${info.log?.processPaths.length ? info.log.processPaths.join(', ') : 'none'}`,
    `Executor launch source: ${info.log?.sidecarSource ?? 'unknown'}`,
    `Executor launch path: ${info.log?.sidecarPath ?? 'unknown'}`,
    `Current working directory: ${info.log?.currentDir ?? 'unknown'}`,
    `Executor home: ${info.log?.executorHome ?? 'unknown'}`,
    `Backend URL: ${info.log?.backendUrl ?? 'none'}`,
    `Backend auth token configured: ${info.log ? String(info.log.hasBackendAuthToken) : 'unknown'}`,
    `Pending request count: ${info.log?.pendingRequestCount ?? 'unknown'}`,
    `Local executor status: running=${info.log?.status.running ?? 'unknown'} ready=${info.log?.status.ready ?? 'unknown'} deviceId=${info.log?.status.deviceId ?? 'none'} version=${info.log?.status.version ?? 'none'} error=${info.log?.status.error ?? 'none'}`,
    ...(logPath ? [`Executor log path: ${logPath}`] : []),
    `Executor log truncated: ${info.log?.truncated ? 'true' : 'false'}`,
    `Executor log lines: last ${info.log?.lineCount ?? 0}`,
    '',
    '--- Executor log ---',
    logContent,
  ].join('\n')

  return sanitizeLocalRuntimeDebugText(debugText)
}

async function copyDebugInfoText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch (error) {
    console.warn('[KCoder Studio] Clipboard copy failed; retrying with native app copy.', error)
  }

  await copyLocalExecutorDebugInfo(text)
}

interface CopyStartupDiagnosticsProps {
  copyState: CopyDebugState
  onCopyDebugInfo: () => void
}

function CopyStartupDiagnostics({ copyState, onCopyDebugInfo }: CopyStartupDiagnosticsProps) {
  const { t } = useTranslation('localRuntime')
  const copied = copyState === 'copied'
  const copying = copyState === 'copying'
  const failed = copyState === 'failed'
  const buttonLabel = copied
    ? t('copy_debug_copied')
    : copying
      ? t('copy_debug_copying')
      : failed
        ? t('copy_debug_failed')
        : t('copy_debug')
  const Icon = copied ? Check : Copy

  return (
    <Button
      type="button"
      variant="outline"
      className="h-11 min-w-[44px] border-border bg-base px-3 text-xs text-text-primary hover:bg-muted sm:h-9 sm:w-auto"
      onClick={onCopyDebugInfo}
      disabled={copying}
      data-testid="local-runtime-copy-debug-button"
    >
      <Icon className="h-4 w-4" />
      {buttonLabel}
    </Button>
  )
}

export function LocalRuntimeInitializer({
  children,
  initialCloudConnection,
  startupReady = true,
  waitForInitialPage = false,
}: LocalRuntimeInitializerProps) {
  const { t } = useTranslation('localRuntime')
  const { t: tCommon } = useTranslation('common')
  const enabled = useMemo(() => shouldInitializeLocalRuntime(), [])
  const fallbackError = t('fallback_error')
  const initialCloudConnectionRef = useRef(initialCloudConnection)
  const [slowStartupTimedOut, setSlowStartupTimedOut] = useState(false)
  const [startupAttempt, setStartupAttempt] = useState(0)
  const appContentRef = useRef<HTMLDivElement>(null)
  const [initialPageReady, setInitialPageReady] = useState(false)
  const [copyDebugState, setCopyDebugState] = useState<CopyDebugState>('idle')
  const [diagnosticLog, setDiagnosticLog] = useState<{
    attempt: number
    error: string | null
    path: string
  } | null>(null)
  const runtimeErrorText = useMemo(
    () => ({
      notRunning: t('error_not_running'),
      notReady: t('error_not_ready'),
    }),
    [t]
  )
  const [state, setState] = useState<LocalRuntimeState>(() => ({
    phase: enabled ? 'starting' : 'ready',
    error: null,
  }))

  useLayoutEffect(() => {
    const content = appContentRef.current
    if (!waitForInitialPage || initialPageReady || state.phase !== 'ready' || !content) return
    // Let the initial route mount under the same startup scene. A fallback
    // in a retained, hidden page must not delay the visible route.
    const reveal = () => {
      const pending = Array.from(content.querySelectorAll('[data-studio-page-pending]'))
      if (pending.some(element => element.getClientRects().length > 0)) return
      observer.disconnect()
      setInitialPageReady(true)
    }
    const observer = new MutationObserver(reveal)
    observer.observe(content, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['hidden', 'aria-hidden', 'class', 'style'] })
    reveal()
    return () => observer.disconnect()
  }, [waitForInitialPage, initialPageReady, state.phase])

  useEffect(() => {
    if (!enabled && !waitForInitialPage) {
      return undefined
    }

    const timer = window.setTimeout(() => {
      setSlowStartupTimedOut(true)
    }, LOCAL_RUNTIME_SLOW_STARTUP_MS)
    return () => window.clearTimeout(timer)
  }, [enabled, startupAttempt, waitForInitialPage])

  const retryInitialize = useCallback(async () => {
    if (!enabled) return
    setStartupAttempt(attempt => attempt + 1)
    setSlowStartupTimedOut(false)
    setCopyDebugState('idle')
    setState({ phase: 'starting', error: null })
    setState(await resolveLocalRuntimeState(fallbackError, runtimeErrorText))
  }, [enabled, fallbackError, runtimeErrorText])

  useEffect(() => {
    if (!enabled) return undefined
    let cancelled = false
    void resolveLocalRuntimeState(fallbackError, runtimeErrorText).then(nextState => {
      if (!cancelled) {
        setState(nextState)
      }
    })
    return () => {
      cancelled = true
    }
  }, [enabled, fallbackError, runtimeErrorText])

  useEffect(() => {
    if (state.phase !== 'failed') return
    let cancelled = false
    void (async () => {
      try {
        const log = await readLocalExecutorLog()
        const path = log?.path?.trim()
        if (!cancelled && path) setDiagnosticLog({ attempt: startupAttempt, error: state.error, path })
      } catch {
        // A failed diagnostic read cannot establish a log file location.
      }
    })()
    return () => { cancelled = true }
  }, [state.phase, state.error, startupAttempt])

  useEffect(() => {
    if (!enabled || state.phase !== 'ready' || !initialCloudConnectionRef.current) return

    void applyLocalExecutorCloudConnection(initialCloudConnectionRef.current).catch(error => {
      console.error('[KCoder Studio] Failed to apply cloud connection to local executor:', error)
    })
  }, [enabled, state.phase])

  const handleCopyDebugInfo = useCallback(async () => {
    setCopyDebugState('copying')
    let log: LocalExecutorLog | null = null
    let logError: string | null = null

    try {
      log = await readLocalExecutorLog()
    } catch (error) {
      logError = errorMessage(error, t('debug_log_read_failed'))
    }

    const debugInfo = formatLocalRuntimeDebugInfo({
      capturedAt: new Date().toISOString(),
      runtimeMode: getRuntimeConfig().runtimeMode,
      phase: state.phase,
      startupReady,
      ensureCallState:
        state.phase === 'starting' ? 'pending' : state.phase === 'failed' ? 'failed' : 'resolved',
      error: state.error,
      log,
      logError,
    })

    try {
      await copyDebugInfoText(debugInfo)
      setCopyDebugState('copied')
    } catch {
      setCopyDebugState('failed')
    }
  }, [startupReady, state.error, state.phase, t])

  if (state.phase === 'account-login') {
    return <KCoderAccountStartup onChanged={retryInitialize} />
  }
  const canMountChildren = state.phase === 'ready'
  const canRevealChildren = canMountChildren && (!waitForInitialPage || initialPageReady)
  const shouldShowStartupScreen = !canRevealChildren
  const failed = state.phase === 'failed'
  const diagnosticPath = failed && diagnosticLog?.attempt === startupAttempt && diagnosticLog.error === state.error
    ? diagnosticLog.path : null

  return (
    <>
      {canMountChildren && (
        <div ref={appContentRef} aria-hidden={!canRevealChildren} inert={!canRevealChildren}
          style={canRevealChildren ? undefined : { position: 'absolute', inset: 0, visibility: 'hidden' }}>
          {children}
        </div>
      )}
      {shouldShowStartupScreen && (
        <main
          data-testid="local-runtime-initializer"
          className={
            failed
              ? 'relative flex min-h-screen items-center justify-center overflow-auto bg-base px-6 py-10 text-text-primary'
              : 'kcoder-startup-shell'
          }
          aria-busy={!failed}
        >
          <div
            data-testid="local-runtime-titlebar-drag-region"
            className="absolute inset-x-0 top-0 h-[52px]"
          >
            <MacOSTitleBarDragRegion className="h-full w-full" />
          </div>
          {!failed && <StartupBrand />}
          <section
            className={
              failed
                ? 'flex w-full max-w-[520px] flex-col items-center text-center'
                : 'kcoder-startup-content'
            }
          >
            {failed ? (
              <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-lg border border-border bg-surface text-text-secondary">
                <AlertCircle className="h-6 w-6 text-amber-600" />
              </div>
            ) : (
              <StartupIllustration />
            )}
            {!failed && <StartupWordmark />}
            <h1 className={failed ? 'heading-base' : 'kcoder-startup-heading'}>
              {failed ? t('failed_title') : t('starting_title')}
            </h1>
            {failed ? (
              <p className="mt-3 max-w-[360px] text-sm leading-6 text-text-secondary">
                {t('failed_description')}
              </p>
            ) : (
              <div className="grid w-full justify-items-center">
                <p className={`kcoder-startup-description col-start-1 row-start-1 ${slowStartupTimedOut ? 'invisible' : ''}`}>
                  {t('starting_description')}
                </p>
                <div
                  data-testid="local-runtime-slow-startup-help"
                  aria-hidden={!slowStartupTimedOut}
                  className={`col-start-1 row-start-1 mt-3 flex flex-wrap items-center justify-center gap-x-3 text-sm text-text-secondary ${slowStartupTimedOut ? '' : 'invisible'}`}
                >
                  <p>{t('slow_startup_description')}</p>
                  <Button variant="ghost" onClick={() => window.location.reload()}>
                    {tCommon('common.reload_page')}
                  </Button>
                </div>
              </div>
            )}

            {failed ? (
              <div className="studio-card-spacing mt-6 w-full rounded-lg border border-border bg-surface px-4 py-3 text-left">
                {state.error && (
                  <p
                    data-testid="local-runtime-error"
                    className="break-words text-sm leading-6 text-text-primary"
                  >
                    {state.error}
                  </p>
                )}
                {diagnosticPath && <div className="mt-3 text-xs leading-5 text-text-secondary" data-testid="local-runtime-log-path">
                  <span className="font-medium">{t('log_label')}: </span>
                  <code className="break-all rounded bg-base px-1.5 py-0.5 text-text-primary">
                    {diagnosticPath}
                  </code>
                </div>}
              </div>
            ) : (
              <StartupSteps />
            )}

            {failed && (
              <div className="mt-6 flex flex-col items-center gap-3">
                <Button
                  type="button"
                  variant="primary"
                  className="h-10 min-w-[112px]"
                  onClick={() => void retryInitialize()}
                  data-testid="local-runtime-retry-button"
                >
                  <RefreshCw className="h-4 w-4" />
                  {t('retry')}
                </Button>
                <details className="text-sm text-text-secondary">
                  <summary className="cursor-pointer">{t('startup_diagnostics')}</summary>
                  <CopyStartupDiagnostics copyState={copyDebugState} onCopyDebugInfo={handleCopyDebugInfo} />
                </details>
              </div>
            )}
          </section>
          {!failed && <StartupSignature />}
        </main>
      )}
    </>
  )
}
