import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { publicOfficeError } from './controller'
export function OfficeErrorNotice({ error, onClose, onRead }: { error: unknown; onClose: () => void; onRead?: () => void }) {
  const { t } = useTranslation('officeIntegration')
  const problem = publicOfficeError(error)
  return <div role="alert" className="studio-card-spacing space-y-2 rounded-lg border border-border bg-surface text-base text-text-secondary">
    <p>{t(problem.recovery === 'reconcile_original' ? 'unknown' : problem.code === 'OFFICE_SCOPE_CHANGED' ? 'stale' : 'unavailable')}</p>
    <details><summary className="cursor-pointer text-sm">{t('detail')}</summary><code className="block break-all text-sm">{problem.code}{problem.operationId ? ` · ${problem.operationId}` : ''}</code></details>
    <div className="flex flex-wrap gap-2">{onRead && <Button variant="outline" size="sm" onClick={onRead}>{t('recovery')}</Button>}<Button variant="ghost" size="sm" onClick={onClose}>{t('close')}</Button></div>
  </div>
}
