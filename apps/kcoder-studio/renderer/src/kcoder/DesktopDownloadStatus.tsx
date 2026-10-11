import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { DesktopDownloadResult } from '../../../desktop/download-contract'

interface FileReadError {
  message: string
  upgrade: boolean
}
export function DesktopDownloadStatus() {
  const { t } = useTranslation('common')
  const [fileError, setFileError] = useState<FileReadError | null>(null)
  const [result, setResult] = useState<DesktopDownloadResult | null>(null)
  useEffect(() => {
    const listener = (event: Event) => {
      setFileError(null)
      setResult((event as CustomEvent<DesktopDownloadResult>).detail)
    }
    const readError = (event: Event) => {
      setResult(null)
      setFileError((event as CustomEvent<FileReadError>).detail)
    }
    window.addEventListener('kcoder:download-result', listener)
    window.addEventListener('kcoder:native-file-read-error', readError)
    return () => {
      window.removeEventListener('kcoder:download-result', listener)
      window.removeEventListener('kcoder:native-file-read-error', readError)
    }
  }, [])
  if (!result && !fileError) return null
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="desktop-download-status"
      className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary shadow-sm"
    >
      <span>
        {fileError
          ? fileError.upgrade
            ? t('nativeFileRead.upgrade')
            : fileError.message
          : t(`download.${result!.status}`)}
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t('common.close', 'Close')}
        onClick={() => {
          setResult(null)
          setFileError(null)
        }}
      >
        <X />
      </Button>
    </div>
  )
}
