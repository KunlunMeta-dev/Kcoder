import { WikiError } from './WikiError'
import { WikiSourceActions } from './WikiSourceActions'
import { useEffect, useState } from 'react'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { knowledgeApi, type WikiSource } from '@/kcoder/knowledgeApi'

export function WikiSourceReader({
  serverId,
  libraryId,
  source,
  isCurrent,
  onClose,
  onChanged,
  canOrganize,
}: {
  serverId: string
  libraryId: string
  source: WikiSource
  isCurrent: () => boolean
  onClose: () => void
  onChanged: (source?: WikiSource) => void
  canOrganize: boolean
}) {
  const { t } = useTranslation('knowledge')
  const [content, setContent] = useState<Awaited<ReturnType<typeof knowledgeApi.source>> | null>(
    null
  )
  const [cursor, setCursor] = useState(0)
  const [previous, setPrevious] = useState<number[]>([])
  const [error, setError] = useState('')
  const [originalError, setOriginalError] = useState('')
  const imageKey = JSON.stringify([serverId, libraryId, source.sourceId, source.revisionId])
  const [image, setImage] = useState<{ key: string; url: string } | null>(null)
  const [downloading, setDownloading] = useState(false)
  useEffect(() => {
    let disposed = false
    let url: string | undefined
    if (/\.(png|jpe?g|webp)$/i.test(source.title)) {
      void knowledgeApi
        .originalFile(serverId, libraryId, source, isCurrent)
        .then(value => {
          if (disposed || !isCurrent() || !value.blob.type.startsWith('image/')) return
          url = URL.createObjectURL(value.blob)
          setImage({ key: imageKey, url })
        })
        .catch(cause => {
          if (!disposed && isCurrent())
            setOriginalError(cause instanceof Error ? cause.message : String(cause))
        })
    }
    return () => {
      disposed = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [serverId, libraryId, source, isCurrent, imageKey])
  const download = async () => {
    setDownloading(true)
    try {
      const value = await knowledgeApi.originalFile(serverId, libraryId, source, isCurrent)
      if (!isCurrent()) return
      const url = URL.createObjectURL(value.blob),
        link = document.createElement('a')
      link.href = url
      link.download = value.filename
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (cause) {
      if (isCurrent()) setOriginalError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (isCurrent()) setDownloading(false)
    }
  }
  useEffect(() => {
    let active = true
    void knowledgeApi
      .source(serverId, libraryId, source, cursor)
      .then(value => {
        if (active && isCurrent()) {
          setContent(value)
          setError('')
        }
      })
      .catch(cause => {
        if (active && isCurrent()) setError(String(cause instanceof Error ? cause.message : cause))
      })
    return () => {
      active = false
    }
  }, [serverId, libraryId, source, cursor, isCurrent])
  const navigate = (next: number) => {
    setContent(null)
    setCursor(next)
  }
  return (
    <ModalDialog
      title={source.title}
      testId="wiki-original-reader"
      wide
      closeLabel={t('closeSource')}
      onClose={onClose}
    >
      {error && <WikiError error={error} />}
      {originalError && <WikiError error={originalError} />}
      {image?.key === imageKey && (
        <img
          data-testid="wiki-original-image"
          src={image.url}
          alt={source.title}
          className="my-4 max-h-[60vh] w-full rounded-lg object-contain"
        />
      )}
      <div className="my-4 min-h-40 max-h-[60vh] space-y-5 overflow-y-auto">
        {!content ? (
          <p className="text-sm text-text-muted">{t('loading')}</p>
        ) : (
          content.items.map(chunk => (
            <section key={chunk.chunkId}>
              <p className="mb-2 text-xs text-text-muted">
                {chunk.page
                  ? t('sourcePage', { page: chunk.page })
                  : t('sourceLines', { start: chunk.firstLine, end: chunk.lastLine })}
              </p>
              <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {chunk.text}
              </pre>
            </section>
          ))
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="max-md:min-h-11"
          data-testid="wiki-original-download"
          disabled={downloading}
          onClick={() => void download()}
        >
          {t('downloadOriginal')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!content || !previous.length}
          onClick={() => {
            navigate(previous[previous.length - 1])
            setPrevious(value => value.slice(0, -1))
          }}
        >
          {t('previousPart')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!content?.nextAfterChunk}
          onClick={() => {
            setPrevious(value => [...value, cursor])
            navigate(content!.nextAfterChunk!)
          }}
        >
          {t('nextPart')}
        </Button>
      </div>
      {canOrganize && (
        <WikiSourceActions
          serverId={serverId}
          libraryId={libraryId}
          source={source}
          isCurrent={isCurrent}
          onChanged={onChanged}
          onClose={onClose}
        />
      )}
    </ModalDialog>
  )
}
