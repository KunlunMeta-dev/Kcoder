import { useOptionalAppUpdate } from '@/features/app-update/app-update-context'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { Download, Loader2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { calculateSidebarUpdateDownloadPercent, formatSidebarTemplate } from './sidebarSelectors'

export function SidebarAppUpdateButton({ onBeforeInstall }: { onBeforeInstall?: () => void }) {
  const { t } = useTranslation('common')
  const appUpdate = useOptionalAppUpdate()
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [errorTooltipPosition, setErrorTooltipPosition] = useState<{
    left: number
    top: number
  } | null>(null)
  const availableUpdate = appUpdate?.availableUpdate ?? null
  const status = appUpdate?.status ?? 'idle'
  const downloadProgress = appUpdate?.downloadProgress ?? null
  const error = appUpdate?.error ?? null
  const busy = status === 'checking' || status === 'installing'
  const downloadPercent = downloadProgress
    ? calculateSidebarUpdateDownloadPercent(
        downloadProgress.downloadedBytes,
        downloadProgress.totalBytes
      )
    : null

  const showErrorTooltip = () => {
    if (!error || !buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    setErrorTooltipPosition({
      left: Math.min(rect.right + 8, Math.max(8, window.innerWidth - 268)),
      top: Math.min(Math.max(8, rect.top + rect.height / 2), window.innerHeight - 8),
    })
  }

  if (!appUpdate || !availableUpdate) return null

  const title = availableUpdate
    ? formatSidebarTemplate(
        t('workbench.app_update_install', {
          defaultValue: '更新到 {{version}}',
          version: availableUpdate.version,
        }),
        { version: availableUpdate.version }
      )
    : t('workbench.app_update_check', '检查更新')
  const downloadTitle =
    downloadPercent === null
      ? t('workbench.app_update_downloading', { defaultValue: '正在下载更新' })
      : formatSidebarTemplate(
          t('workbench.app_update_downloading_progress', {
            defaultValue: '正在下载更新 {{progress}}%',
            progress: downloadPercent,
          }),
          { progress: String(downloadPercent) }
        )

  return (
    <div
      className="group/update relative shrink-0"
      onPointerEnter={showErrorTooltip}
      onPointerLeave={() => setErrorTooltipPosition(null)}
      onFocus={showErrorTooltip}
      onBlur={() => setErrorTooltipPosition(null)}
    >
      <button
        ref={buttonRef}
        type="button"
        data-testid="sidebar-app-update-button"
        disabled={busy}
        onClick={() => {
          onBeforeInstall?.()
          if (availableUpdate) {
            void appUpdate.installUpdate()
            return
          }
          void appUpdate.checkNow()
        }}
        title={error ?? (status === 'installing' ? downloadTitle : title)}
        aria-label={error ?? (status === 'installing' ? downloadTitle : title)}
        className={cn(
          'group relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-60',
          error
            ? 'text-red-500 hover:bg-red-500/10'
            : 'text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]'
        )}
      >
        {status === 'installing' && downloadPercent !== null ? (
          <SidebarUpdateDownloadProgress progress={downloadPercent} />
        ) : busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="sidebar-update-download-icon h-4 w-4" />
        )}
        {availableUpdate && !busy && (
          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-primary ring-2 ring-[rgb(var(--color-sidebar-hover))]" />
        )}
        {error && (
          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500 ring-2 ring-[rgb(var(--color-sidebar-hover))]" />
        )}
      </button>
      {error && errorTooltipPosition
        ? createPortal(
            <div
              data-testid="sidebar-app-update-error"
              style={errorTooltipPosition}
              className="fixed z-system-popover w-[260px] -translate-y-1/2 rounded-lg border border-red-500/20 bg-popover px-3 py-2 text-xs font-medium leading-5 text-red-500 shadow-[0_12px_28px_rgba(0,0,0,0.18)] [overflow-wrap:anywhere]"
            >
              {error}
            </div>,
            document.body
          )
        : null}
    </div>
  )
}

export function SidebarUpdateDownloadProgress({ progress }: { progress: number }) {
  return (
    <span
      data-testid="sidebar-app-update-download-progress"
      role="progressbar"
      aria-label={`Update download ${progress}%`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress}
      className="flex h-4 w-4 items-center justify-center rounded-full"
      style={{
        background: `conic-gradient(rgb(var(--color-primary)) ${progress}%, rgb(var(--color-sidebar-hover)) 0)`,
      }}
    >
      <span className="h-2 w-2 rounded-full bg-[rgb(var(--color-sidebar))]" />
    </span>
  )
}
