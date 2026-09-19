import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { Download, X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { isNativeTauriHost } from '@/lib/runtime-environment'
import { localPathFromMarkdownImageSrc } from './assistantMarkdownLinks'

interface MarkdownImagePreviewProps {
  src: string
  rawSrc: string
  alt: string
  onError: () => void
}

export function MarkdownImagePreview({ src, rawSrc, alt, onError }: MarkdownImagePreviewProps) {
  const { t } = useTranslation('common')
  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const downloadRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const filename = getMarkdownImageFilename(rawSrc, alt)
  const closeLabel = t('workbench.close_dialog', '关闭')
  const downloadLabel = t('workbench.browser_settings_downloads', '下载')

  useEffect(() => {
    if (!isOpen) return
    const trigger = triggerRef.current
    closeRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setIsOpen(false)
        return
      }
      if (event.key !== 'Tab') return

      event.preventDefault()
      const focusDownload = event.shiftKey
        ? document.activeElement === closeRef.current
        : document.activeElement !== downloadRef.current
      if (focusDownload) downloadRef.current?.focus()
      else closeRef.current?.focus()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.requestAnimationFrame(() => trigger?.focus())
    }
  }, [isOpen])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="assistant-markdown-image-button"
        className="my-2 block max-w-full cursor-zoom-in rounded-xl p-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70"
        onClick={() => setIsOpen(true)}
        aria-label={alt || filename}
      >
        <img
          data-testid="assistant-markdown-image"
          data-scroll-anchor
          src={src}
          alt={alt}
          referrerPolicy="no-referrer"
          className="block max-h-[360px] max-w-full rounded-xl border border-border bg-base object-contain"
          loading="lazy"
          onError={onError}
        />
      </button>
      {isOpen && typeof document !== 'undefined'
        ? createPortal(
            <div
              data-testid="attachment-image-lightbox"
              role="dialog"
              aria-modal="true"
              aria-label={alt || filename}
              className="fixed inset-0 z-modal flex h-dvh w-dvw items-center justify-center overflow-hidden bg-black/90 p-6"
              onMouseDown={event => {
                if (event.target === event.currentTarget) setIsOpen(false)
              }}
            >
              <div className="absolute right-4 top-4 flex items-center gap-2">
                <button
                  ref={downloadRef}
                  type="button"
                  data-testid="attachment-image-download"
                  className="flex h-12 w-12 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                  onClick={() => void downloadMarkdownImage(src, rawSrc, filename)}
                  aria-label={downloadLabel}
                  title={downloadLabel}
                >
                  <Download className="h-5 w-5" aria-hidden="true" />
                </button>
                <button
                  ref={closeRef}
                  type="button"
                  data-testid="attachment-image-lightbox-close"
                  className="flex h-12 w-12 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                  onClick={() => setIsOpen(false)}
                  aria-label={closeLabel}
                  title={closeLabel}
                >
                  <X className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>
              <img
                data-testid="attachment-image-lightbox-image"
                src={src}
                alt={alt}
                referrerPolicy="no-referrer"
                className="max-h-[calc(100dvh-8rem)] max-w-[calc(100dvw-4rem)] rounded-xl object-contain"
                onError={onError}
              />
            </div>,
            document.body
          )
        : null}
    </>
  )
}

function getMarkdownImageFilename(src: string, alt: string): string {
  const cleanSrc = localPathFromMarkdownImageSrc(src).split(/[?#]/, 1)[0]
  const lastSegment = cleanSrc.split(/[\\/]/).pop()
  if (lastSegment && /\.[a-z0-9]+$/i.test(lastSegment)) return lastSegment
  return alt || 'image'
}

function getDownloadableLocalPath(src: string): string | null {
  if (/^(?:asset|blob|data|https?):/i.test(src)) return null
  const path = localPathFromMarkdownImageSrc(src)
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) ? path : null
}

async function downloadMarkdownImage(src: string, rawSrc: string, filename: string) {
  const sourcePath = getDownloadableLocalPath(rawSrc)
  if (sourcePath && isNativeTauriHost()) {
    await invoke<string>('download_local_file_to_downloads', { sourcePath, filename })
    return
  }

  let downloadUrl = src
  let objectUrl: string | null = null
  if (!/^(?:blob|data):/i.test(src)) {
    try {
      const response = await fetch(src)
      if (!response.ok) throw new Error(`Failed to download markdown image: ${response.status}`)
      objectUrl = URL.createObjectURL(await response.blob())
      downloadUrl = objectUrl
    } catch {
      // If a cross-origin image cannot be refetched, let the browser attempt a direct download from the original address.
    }
  }

  const link = document.createElement('a')
  link.href = downloadUrl
  link.download = filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  if (objectUrl) window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
}
