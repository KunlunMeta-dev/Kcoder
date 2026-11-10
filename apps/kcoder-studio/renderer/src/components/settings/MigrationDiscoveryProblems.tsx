import { useTranslation } from '@/hooks/useTranslation'
import type { MigrationDiscoveryProblem } from '../../../../shared/generated/contracts'

/** Render only public diagnostic codes, never raw source documents or parser errors. */
export function MigrationDiscoveryProblems({
  problems,
}: {
  problems: MigrationDiscoveryProblem[]
}) {
  const { t } = useTranslation('migration')
  const unique = [...new Map(problems.map(problem => [JSON.stringify(problem), problem])).values()]
  if (!unique.length) return null
  return (
    <div role="status" className="space-y-1 text-sm text-destructive">
      <p>{t('batch.source_problems')}</p>
      <ul className="max-h-40 list-disc space-y-1 overflow-y-auto pl-5">
        {unique.map(problem => (
          <li key={JSON.stringify(problem)}>
            {problem.kind === 'claude-code' ? 'Claude Code' : 'Codex'} ·{' '}
            {t(`errors.${problem.code}`, { defaultValue: t('discovery_problem') })}
          </li>
        ))}
      </ul>
    </div>
  )
}
