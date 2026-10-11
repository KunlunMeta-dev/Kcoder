import FileViewer, { type FileViewerHandle, type FileViewerProps } from '@file-viewer/react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { workspaceViewerOptions } from './workspaceViewerOptions'

interface WorkspaceDocumentViewerProps {
  file: File
  filename: string
  type?: string
  size: number
  options: FileViewerProps['options']
}

/** One source owner avoids the upstream mount + update effects reading twice. */
export const WorkspaceDocumentViewer = memo(function WorkspaceDocumentViewer({
  file,
  filename,
  type,
  size,
  options,
}: WorkspaceDocumentViewerProps) {
  const { t } = useTranslation()
  const viewerRef = useRef<FileViewerHandle>(null)
  const isolatedOptions = useMemo(() => workspaceViewerOptions(options), [options])
  const source = useMemo(
    () => ({ file, filename, type, size, options: isolatedOptions }),
    [file, filename, type, size, isolatedOptions]
  )
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<{
    source: typeof source
    attempt: number
    status: 'ready' | 'error'
  } | null>(null)
  const status = phase?.source === source && phase.attempt === attempt ? phase.status : 'loading'

  useEffect(() => {
    let active = true
    // StrictMode cancels the first effect before this microtask starts. Do not
    // launch its uncancellable File read or reuse a cancelled load's result.
    void Promise.resolve()
      .then(async () => {
        if (!active) return
        setPhase(null)
        const viewer = viewerRef.current
        if (!viewer) throw new Error('File viewer controller unavailable')
        await viewer.load(source)
        if (active) setPhase({ source, attempt, status: 'ready' })
      })
      .catch(() => {
        if (active) setPhase({ source, attempt, status: 'error' })
      })
    return () => {
      active = false
    }
  }, [source, attempt])

  return (
    <div className="relative h-full w-full" data-testid="workspace-document-viewer">
      {/* Keep source/options on the explicit load only. The upstream component
          owns controller/renderer destruction; never destroy it again here. */}
      <FileViewer
        ref={viewerRef}
        className="h-full w-full"
        aria-hidden={status !== 'ready'}
        inert={status !== 'ready'}
        data-testid="workspace-document-viewer-surface"
      />
      {status === 'loading' && (
        <div
          role="status"
          data-testid="workspace-document-viewer-loading"
          className="absolute inset-0 flex items-center justify-center bg-background text-sm text-text-muted"
        >
          {t('workbench.workspace_file_preview_loading')}
        </div>
      )}
      {status === 'error' && (
        <div
          role="alert"
          data-testid="workspace-document-viewer-error"
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background px-4 text-center text-sm text-destructive"
        >
          <p>{t('workbench.workspace_file_render_failed')}</p>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="max-md:min-h-11 max-md:min-w-11"
            data-testid="workspace-document-viewer-retry"
            onClick={() => setAttempt(previous => previous + 1)}
          >
            {t('workbench.workspace_file_retry')}
          </Button>
        </div>
      )}
    </div>
  )
})
