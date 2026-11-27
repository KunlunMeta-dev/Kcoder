import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { MigrationInstructionBodyResult } from '../../../../shared/generated/contracts'

export function MigrationInstructionBodyView({ body, busy, onNext }: { body: MigrationInstructionBodyResult; busy: boolean; onNext(): void }) {
  const { t } = useTranslation('migrationInstructions')
  return <div data-testid="instruction-body" className="studio-card-spacing space-y-2 rounded-md border border-border">
    <p className="text-sm text-text-secondary">{t(body.representation)} · {t('previewBoundary')}</p>
    {body.encoding === 'binary' && <p className="text-sm text-text-secondary">{t('binary')}</p>}
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs leading-5" data-testid="instruction-body-text">{body.text ?? body.bytesBase64}</pre>
    <details className="text-xs text-text-secondary"><summary className="cursor-pointer">{t('details')}</summary><p className="mt-2 break-all">{body.formatRevision} · {body.sha256}</p><p>{body.offset} / {body.totalBytes}</p></details>
    {body.nextOffset != null && <Button size="sm" variant="ghost" disabled={busy} onClick={onNext}>{t('nextBody')}</Button>}
  </div>
}
