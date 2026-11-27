import { useRef, useState, type ReactNode } from 'react'
import { FilePlus2, FileText, FolderOpen, Image, Info, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import {
  wikiFileAccept,
  wikiFileCapabilities,
  type WikiFileCapability,
} from './wikiFileCapabilities'

/** File selection only; upload and organization remain owned by the caller. */
export function WikiFileImportControls({
  busy,
  onFiles,
  onDirectory,
  capabilities = wikiFileCapabilities,
  actions,
}: {
  busy: boolean
  onFiles: (files: File[]) => void
  onDirectory: () => void
  capabilities?: WikiFileCapability[]
  actions?: ReactNode
}) {
  const { t } = useTranslation('knowledge')
  const picker = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const documents = capabilities.filter(item => !item.requiresVision)
  const images = capabilities.filter(item => item.requiresVision)
  const formatLabels: Record<string, string> = {
    text: 'TXT',
    markdown: 'Markdown',
    html: 'HTML',
    pdf: 'PDF',
    docx: 'Word',
    xlsx: 'Excel',
    pptx: 'PPT',
    image: t('imageFormat'),
  }
  const extensions = capabilities
    .flatMap(item => item.extensions)
    .map(extension => extension.toUpperCase())
    .join('、')
  const limit = (items: WikiFileCapability[]) =>
    Math.max(...items.map(item => item.maxFileBytes)) / (1024 * 1024)
  return (
    <div
      data-testid="knowledge-import-card"
      className="studio-card-spacing space-y-4 rounded-2xl border border-border/70 bg-background"
    >
      <input
        ref={picker}
        type="file"
        data-testid="wiki-import-files"
        multiple
        disabled={busy}
        accept={wikiFileAccept(capabilities)}
        className="hidden"
        aria-label={t('importText')}
        onChange={event => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (!busy && files.length) onFiles(files)
        }}
      />
      <div className="flex flex-wrap items-center gap-3 border-b border-border/60 pb-4">
        <Button
          variant="outline"
          size="sm"
          className="max-md:min-h-11"
          disabled={busy}
          data-testid="wiki-file-import"
          onClick={() => picker.current?.click()}
        >
          <FilePlus2 />
          {t('importText')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="max-md:min-h-11"
          disabled={busy}
          data-testid="wiki-directory-open"
          onClick={onDirectory}
        >
          <FolderOpen />
          {t('importDirectory')}
        </Button>
        {actions && <div className="ml-auto">{actions}</div>}
      </div>
      <div
        data-testid="wiki-upload-dropzone"
        aria-disabled={busy}
        onDragOver={event => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          event.dataTransfer.dropEffect = busy ? 'none' : 'copy'
          if (!busy) setDragging(true)
        }}
        onDragLeave={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={event => {
          event.preventDefault()
          setDragging(false)
          if (busy) return
          const files = Array.from(event.dataTransfer.files)
          if (files.length) onFiles(files)
        }}
        className={`flex flex-wrap items-center gap-4 rounded-xl border border-dashed p-4 transition-colors ${dragging && !busy ? 'border-focus bg-muted/60' : 'border-border/60 bg-surface/50'} ${busy ? 'opacity-60' : ''}`}
      >
        <button
          type="button"
          disabled={busy}
          data-testid="wiki-upload-browse"
          aria-label={t('upload')}
          title={t('upload')}
          onClick={() => picker.current?.click()}
          className="flex size-12 shrink-0 items-center justify-center rounded-xl text-text-primary transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed"
        >
          <Upload className="size-6" aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1 basis-64">
          <p className="text-base font-medium">{t('dropFiles')}</p>
          <p className="mt-1 text-sm leading-relaxed text-text-secondary">
            {t('supportedExtensions', {
              extensions: capabilities
                .map(
                  item =>
                    formatLabels[item.format] ??
                    item.extensions.map(extension => extension.toUpperCase()).join('/')
                )
                .join('、'),
            })}
            <span
              className="ml-2 inline-flex align-middle"
              role="img"
              aria-label={t('supportedExtensions', { extensions })}
              title={`${t('supportedExtensions', { extensions })}\n${t('importHint')}`}
            >
              <Info className="size-4" aria-hidden="true" />
            </span>
          </p>
        </div>
        <div className="flex flex-wrap gap-3 max-sm:w-full">
          {documents.length > 0 && (
            <div className="flex items-center gap-3 rounded-xl bg-background/60 p-3">
              <FileText aria-hidden="true" className="size-5 shrink-0 text-text-secondary" />
              <div>
                <p className="text-sm font-medium">
                  {t('documentSize', { size: limit(documents) })}
                </p>
                <p className="mt-1 text-xs text-text-muted">{t('documentProcessing')}</p>
              </div>
            </div>
          )}
          {images.length > 0 && (
            <div className="flex items-center gap-3 rounded-xl bg-background/60 p-3">
              <Image aria-hidden="true" className="size-5 shrink-0 text-text-secondary" />
              <div>
                <p className="text-sm font-medium">{t('imageSize', { size: limit(images) })}</p>
                <p className="mt-1 text-xs text-text-muted">{t('imageProcessing')}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
