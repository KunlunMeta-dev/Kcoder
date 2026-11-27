import { useTranslation } from '@/hooks/useTranslation'

export type WikiExtractionReport = {
  format: string
  textBytes: number
  chunkCount: number
  unit?: 'page' | 'sheet' | 'slide'
  extractedUnits?: number
  totalUnits?: number
  warnings: string[]
}

/** Warnings that affect use stay visible; routine extraction metadata is expandable. */
export function WikiFileExtraction({ report }: { report?: WikiExtractionReport | null }) {
  const { t } = useTranslation('knowledge')
  if (!report) return null
  return (
    <div
      className="my-3 space-y-2 text-xs text-text-secondary"
      data-testid="wiki-extraction-report"
    >
      {report.warnings.length > 0 && (
        <ul className="space-y-1" aria-label={t('extractionWarnings')}>
          {report.warnings.map(warning => (
            <li key={warning}>{t(`extractionWarning.${warning}`)}</li>
          ))}
        </ul>
      )}
      <details>
        <summary className="cursor-pointer text-text-muted">{t('extractionDetails')}</summary>
        <p className="mt-2">
          {t('extractionSize', {
            format: report.format.toUpperCase(),
            bytes: report.textBytes,
            chunks: report.chunkCount,
          })}
        </p>
        {report.unit && report.extractedUnits !== undefined && (
          <p>
            {t(`extractionUnit.${report.unit}`, {
              count: report.extractedUnits,
              total: report.totalUnits ?? report.extractedUnits,
            })}
          </p>
        )}
      </details>
    </div>
  )
}
