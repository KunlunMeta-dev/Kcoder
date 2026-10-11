import { imageSizeIssue } from '@/lib/imageValidation'
import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { Button } from '@/components/ui/button'
import { toolObservationOutput, hasToolImageObservations } from '@/kcoder/toolObservationOutput'

export function ToolImageObservations({ output }: { output: unknown }) {
  const { t } = useTranslation('chat')
  const { t: commonT } = useTranslation('common')
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({})
  const [selected, setSelected] = useState<number | null>(null)
  const [failed, setFailed] = useState<Set<string>>(() => new Set())
  if (!hasToolImageObservations(output)) return null
  const raw = output as Record<string, unknown>
  const parsed = toolObservationOutput({
    output: raw.output,
    outputImages: raw.images,
    outputImagesOmitted: raw.imagesOmitted,
  }) as {
    output?: unknown
    images?: Array<{ mimeType: string; data: string }>
    imagesOmitted?: boolean
  }
  const normalized = parsed && typeof parsed === 'object' ? parsed : { output: parsed, images: [] }
  const images = normalized.images ?? []
  const source = (index: number) => `data:${images[index].mimeType};base64,${images[index].data}`
  const recordFailure = (src: string) => setFailed(previous => new Set(previous).add(src))
  const selectedImage = selected == null ? null : images[selected]
  return (
    <div className="min-w-0 space-y-2" data-testid="tool-image-observations">
      {typeof normalized.output === 'string' && normalized.output && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-code text-text-secondary">
          {normalized.output}
        </pre>
      )}
      {images.map((_, index) => {
        const src = source(index)
        return failed.has(src) ? (
          <p key={index} role="status" className="text-sm text-text-secondary">
            {t('toolImages.failed')}
          </p>
        ) : (
          <button
            key={index}
            type="button"
            className="block min-h-11 w-full overflow-hidden rounded-lg border border-border bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            aria-label={t('toolImages.open', { index: index + 1 })}
            onClick={() => setSelected(index)}
          >
            <img
              src={src}
              alt={t('toolImages.observation', { index: index + 1 })}
              loading="lazy"
              className="max-h-80 w-full object-contain"
              onLoad={event => {
                const { naturalWidth: width, naturalHeight: height } = event.currentTarget
                setSizes(previous => ({ ...previous, [src]: { width, height } }))
              }}
              onError={() => recordFailure(src)}
            />
          </button>
        )
      })}
      {images.map((_, index) => {
        const size = sizes[source(index)]
        const issue = size && imageSizeIssue(size.width, size.height)
        return issue ? (
          <p key={`size-${index}`} role="status" className="text-sm text-text-secondary">
            {commonT(`imageFeedback.${issue}`, {
              ...size,
              min: 32,
              maxEdge: 8192,
              maxPixels: 16777216,
            })}
          </p>
        ) : null
      })}
      {normalized.imagesOmitted && (
        <p role="status" className="text-sm text-text-secondary">
          {t('toolImages.omitted')}
        </p>
      )}
      {selectedImage && selected != null && (
        <ModalDialog
          title={t('toolImages.observation', { index: selected + 1 })}
          testId="tool-image-preview"
          onClose={() => setSelected(null)}
        >
          <div className="my-3 max-h-[65vh] overflow-auto">
            {failed.has(source(selected)) ? (
              <p role="status">{t('toolImages.failed')}</p>
            ) : (
              <img
                src={source(selected)}
                alt={t('toolImages.observation', { index: selected + 1 })}
                className="h-auto w-full object-contain"
                onError={() => recordFailure(source(selected))}
              />
            )}
          </div>
          <div className="flex justify-end">
            <Button variant="ghost" onClick={() => setSelected(null)}>
              {t('toolImages.close')}
            </Button>
          </div>
        </ModalDialog>
      )}
    </div>
  )
}
