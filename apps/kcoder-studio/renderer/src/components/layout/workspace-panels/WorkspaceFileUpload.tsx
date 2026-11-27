import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { LoaderCircle, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  WorkspaceFileApi,
  WorkspaceTarget,
  WorkspaceUploadResult,
} from '@/types/workspace-files'
import {
  captureAccountContextRevision,
  listenAccountContextChanges,
} from '@/kcoder/accountContextEvents'

interface UploadRecovery {
  files: File[]
  confirmed: number
  parentPath: string
  scope: string
  accountValid: ReturnType<typeof captureAccountContextRevision>
}

export function WorkspaceFileUpload({
  target,
  parentPath,
  upload,
  onUploaded,
}: {
  target: WorkspaceTarget
  parentPath: string
  upload: NonNullable<WorkspaceFileApi['uploadWorkspaceFile']>
  onUploaded: (result: WorkspaceUploadResult, parentPath: string) => Promise<void>
}) {
  const { t } = useTranslation('common')
  const picker = useRef<HTMLInputElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const decision = useRef<((overwrite: boolean) => void) | null>(null)
  const alive = useRef(true)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState('uploading')
  const [progress, setProgress] = useState(0)
  const [label, setLabel] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  const [failureDetail, setFailureDetail] = useState('')
  const [conflict, setConflict] = useState<WorkspaceUploadResult | null>(null)
  const [destination, setDestination] = useState(parentPath)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [recovery, setRecovery] = useState<UploadRecovery | null>(null)
  const scope = `${target.deviceId}\0${target.path}`
  const currentScope = useRef(scope)
  useLayoutEffect(() => {
    currentScope.current = scope
  }, [scope])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      controller.current?.abort()
      decision.current?.(false)
    }
  }, [])
  useEffect(() => {
    if (!busy && restoreFocus.current) {
      restoreFocus.current = false
      if (document.activeElement === document.body) trigger.current?.focus()
    }
  }, [busy])
  useEffect(() => {
    const reset = () => {
      controller.current?.abort()
      decision.current?.(false)
      controller.current = null
      decision.current = null
      setBusy(false)
      setConflict(null)
      setMessage('')
      setRefreshFailed(false)
      setRecovery(null)
      restoreFocus.current = false
    }
    reset()
    return listenAccountContextChanges(deviceId => {
      if (deviceId === target.deviceId) reset()
    })
  }, [scope, target.deviceId])
  const choose = (overwrite: boolean) => {
    const resolve = decision.current
    if (resolve) restoreFocus.current = true
    decision.current = null
    setConflict(null)
    resolve?.(overwrite)
  }
  const cancel = () => {
    controller.current?.abort()
    setPhase('cancelling')
    choose(false)
  }
  const start = async (files: File[], previous?: UploadRecovery) => {
    if (!files.length || controller.current) return
    if (
      previous &&
      (previous.scope !== currentScope.current || !previous.accountValid(target.deviceId))
    )
      return
    const operation = new AbortController()
    controller.current = operation
    const capturedDestination = previous?.parentPath ?? parentPath
    const accountValid = previous?.accountValid ?? captureAccountContextRevision()
    const current = () =>
      alive.current &&
      controller.current === operation &&
      currentScope.current === scope &&
      accountValid(target.deviceId)
    setDestination(capturedDestination)
    setBusy(true)
    setError(false)
    setMessage('')
    setRefreshFailed(false)
    setFailureDetail('')
    setRecovery(null)
    restoreFocus.current = false
    let completed = previous?.confirmed ?? 0
    let nextFile = 0
    let filename = ''
    try {
      for (const file of files) {
        if (operation.signal.aborted) throw new DOMException('Upload cancelled', 'AbortError')
        setLabel(file.name)
        filename = file.name
        setProgress(0)
        setPhase('uploading')
        const result = await upload(target.deviceId, target.path, capturedDestination, file, {
          signal: operation.signal,
          onPhase: value => {
            if (current() && !operation.signal.aborted) setPhase(value)
          },
          onProgress: (sent, total) => {
            if (current() && !operation.signal.aborted)
              setProgress(total ? Math.floor((sent / total) * 100) : 100)
          },
          onConflict: value =>
            new Promise<boolean>(resolve => {
              if (!current() || operation.signal.aborted) {
                resolve(false)
                return
              }
              decision.current = resolve
              setConflict(value)
            }),
        })
        completed += 1
        nextFile += 1
        if (!current()) return
        if (!operation.signal.aborted) setPhase('refreshing')
        try {
          await onUploaded(result, capturedDestination)
        } catch {
          // A committed receipt remains success if only the directory refresh
          // failed. Keep uploading the batch and offer an honest refresh hint.
          if (current()) setRefreshFailed(true)
        }
      }
      if (operation.signal.aborted) throw new DOMException('Upload cancelled', 'AbortError')
      if (current()) setMessage(t('workspace_upload_done', { count: completed }))
    } catch (cause) {
      if (current()) {
        const cancelled =
          operation.signal.aborted ||
          ((cause instanceof Error || cause instanceof DOMException) && cause.name === 'AbortError')
        setError(!cancelled)
        if (cancelled) setMessage(t('workspace_upload_cancelled', { count: completed }))
        else {
          setMessage(
            completed
              ? t('workspace_upload_partial', { count: completed })
              : t('workspace_upload_failed')
          )
          setFailureDetail(`${filename}: ${cause instanceof Error ? cause.message : String(cause)}`)
          if (nextFile < files.length)
            setRecovery({
              files: files.slice(nextFile),
              confirmed: completed,
              parentPath: capturedDestination,
              scope,
              accountValid,
            })
        }
      }
    } finally {
      if (current()) {
        controller.current = null
        setBusy(false)
        setConflict(null)
      }
    }
  }
  return (
    <div className="relative">
      <input
        ref={picker}
        type="file"
        multiple
        disabled={busy}
        className="hidden"
        data-testid="workspace-upload-input"
        onChange={event => {
          const files = Array.from(event.currentTarget.files ?? [])
          event.currentTarget.value = ''
          void start(files)
        }}
      />
      <Button
        ref={trigger}
        variant="ghost"
        size="icon"
        className="h-8 w-8 max-md:min-h-11 max-md:min-w-11"
        title={t('workspace_upload')}
        aria-label={t('workspace_upload')}
        data-testid="workspace-upload-button"
        disabled={busy}
        onClick={() => picker.current?.click()}
      >
        <Upload />
      </Button>
      {(busy || message) && (
        <div
          role={error ? 'alert' : 'status'}
          data-testid="workspace-upload-status"
          className="absolute right-0 top-10 z-system-popover w-72 max-w-[80vw] rounded-xl border border-border bg-popover p-3 text-xs text-text-secondary shadow-lg"
        >
          <div className="flex items-center gap-2">
            {busy && <LoaderCircle className="size-4 shrink-0 animate-spin" />}
            <span className="min-w-0 flex-1 truncate" title={busy ? label : message}>
              {busy ? label : message}
            </span>
            <Button
              data-testid="workspace-upload-dismiss"
              variant="ghost"
              size="icon"
              className="h-8 w-8 max-md:min-h-11 max-md:min-w-11"
              disabled={busy && (phase === 'saving' || phase === 'cancelling')}
              aria-label={busy ? t('workspace_upload_cancel') : t('close')}
              onClick={() => {
                if (busy) cancel()
                else {
                  setMessage('')
                  setRecovery(null)
                }
              }}
            >
              <X />
            </Button>
          </div>
          {busy ? (
            <>
              <p className="mt-1">
                {t(`workspace_upload_${phase}`)}
                {phase === 'uploading' ? ` ${progress}%` : ''}
              </p>
              <progress
                className="mt-2 h-1 w-full accent-text-primary"
                value={progress}
                max={100}
                aria-label={t('workspace_upload_progress')}
              />
            </>
          ) : (
            error && <p className="mt-1 break-words text-destructive">{failureDetail}</p>
          )}
          <p
            className="mt-2 truncate text-text-muted"
            data-testid="workspace-upload-destination"
            title={destination}
          >
            {destination}
          </p>
          {!busy && recovery && (
            <Button
              type="button"
              data-testid="workspace-upload-retry"
              variant="outline"
              size="sm"
              className="mt-3 max-md:min-h-11"
              onClick={() => void start(recovery.files, recovery)}
            >
              {t('workspace_upload_retry', { count: recovery.files.length })}
            </Button>
          )}
          {refreshFailed && (
            <p className="mt-2 break-words" data-testid="workspace-upload-refresh-error">
              {t('workspace_upload_refresh_failed')}
            </p>
          )}
        </div>
      )}
      {conflict && (
        <ModalDialog
          title={t('workspace_upload_conflict')}
          testId="workspace-upload-conflict"
          onClose={cancel}
          closeLabel={t('workspace_upload_cancel')}
        >
          <p className="mt-3 break-words text-sm">
            {t('workspace_upload_conflict_hint', { name: conflict.name })}
          </p>
          <p className="mt-2 break-all text-xs text-text-muted">{conflict.path}</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button
              variant="outline"
              autoFocus
              data-testid="workspace-upload-cancel"
              onClick={cancel}
            >
              {t('workspace_upload_cancel')}
            </Button>
            <Button data-testid="workspace-upload-overwrite" onClick={() => choose(true)}>
              {t('workspace_upload_overwrite')}
            </Button>
          </div>
        </ModalDialog>
      )}
    </div>
  )
}
