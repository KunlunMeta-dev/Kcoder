import type { ReactNode } from 'react'
import { AlertTriangle, CircleAlert } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { StatusChip } from '@/components/settings/settings-ui'
import type { ExtensionHookIssue } from './extensionsInventory'

/** Definition list for progressive-disclosure details; empty values are omitted. */
export function DetailList({ rows }: { rows: Array<[string, ReactNode]> }) {
  const visible = rows.filter(([, value]) => value !== null && value !== undefined && value !== '')
  if (visible.length === 0) return null
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-[max-content_minmax(0,1fr)]">
      {visible.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-text-muted">{label}</dt>
          <dd className="min-w-0 break-all text-text-secondary">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Disclosure({
  summary,
  testId,
  children,
}: {
  summary: ReactNode
  testId?: string
  children: ReactNode
}) {
  return (
    <details data-testid={testId} className="group/details mt-2">
      <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-md text-sm text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus md:min-h-8">
        {summary}
      </summary>
      <div className="mt-2 space-y-2">{children}</div>
    </details>
  )
}

export function HookIssueList({ issues }: { issues: ExtensionHookIssue[] }) {
  const { t } = useTranslation('extensions')
  if (issues.length === 0) return null
  const hasError = issues.some(issue => issue.severity === 'error')
  return (
    <section
      data-testid="extensions-hook-issues"
      aria-label={t('hookIssues.title')}
      className="studio-card-spacing flex flex-col gap-3 rounded-xl border border-border/60 bg-background"
    >
      <h3 className="text-base font-medium">{t('hookIssues.title')}</h3>
      {hasError && <p className="text-sm text-text-secondary">{t('hookIssues.errorHelp')}</p>}
      <ul className="flex flex-col gap-2">
        {issues.map(issue => (
          <li
            key={`${issue.path}:${issue.location}:${issue.message}`}
            data-testid="extensions-hook-issue"
            data-severity={issue.severity}
            className="flex items-start gap-2 text-sm"
          >
            {issue.severity === 'error' ? (
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
            ) : (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
            )}
            <div className="min-w-0 flex-1">
              <p className="break-words text-text-primary">
                <StatusChip
                  variant={issue.severity === 'error' ? 'destructive' : 'neutral'}
                  className="mr-2"
                >
                  {t(`hookIssues.${issue.severity}`)}
                </StatusChip>
                {issue.message}
              </p>
              <DetailList
                rows={[
                  [t('hookIssues.file'), issue.path],
                  [t('hookIssues.location'), <code key="location">{issue.location}</code>],
                  [t('hookIssues.event'), issue.event],
                ]}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
