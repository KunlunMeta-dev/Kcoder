import type { ReactNode } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { historySourceGroups } from '../../../../shared/migrationHistoryGroups'
import type { HistorySourceSummary } from '../../../../shared/generated/contracts'
import type { HistoryFamilyGroup } from '../../../../shared/migrationHistoryFamilies'

export function MigrationHistoryGroups({ items, children, groups }: {
  items: readonly HistorySourceSummary[]
  children: (item: HistorySourceSummary) => ReactNode
  groups?: readonly HistoryFamilyGroup[] | null
}) {
  const { t } = useTranslation('migration')
  return <div className="space-y-3" data-testid="migration-history-groups">{(groups ?? historySourceGroups(items)).map(group =>
    <section key={group.key} className="divide-y divide-border" data-testid="migration-history-group" data-family-session={group.sessionId}>
      {(group.related || group.items.length > 1 || 'lineageIssue' in group && group.lineageIssue) && <div className="space-y-1 py-2">
        <p className="break-words text-sm font-medium">{t('history.group', { title: group.title ?? group.sessionId })}</p>
        <p className="text-xs text-text-secondary">{t('lineageIssue' in group && group.lineageIssue ? `historyFamilies.issue_${group.lineageIssue}`
          : 'parentObserved' in group && group.parentObserved && !group.parentOnPage ? 'historyFamilies.parentObserved'
            : group.related && !group.parentOnPage ? 'history.group_parent_elsewhere' : 'history.group_explicit')}</p>
      </div>}
      {group.items.map(children)}
    </section>)}</div>
}
