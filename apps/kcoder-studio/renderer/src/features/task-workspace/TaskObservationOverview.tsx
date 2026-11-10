import type { ReactNode } from 'react'
import {
  Activity,
  Bot,
  Circle,
  FileStack,
  FileText,
  GitBranch,
  MessagesSquare,
  Target,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { TaskWorkspaceSnapshot } from '../../../../shared/generated/contracts'

const icons = {
  thread: MessagesSquare,
  goal: Target,
  agents: Bot,
  workflows: GitBranch,
  artifacts: FileText,
  runtime: Activity,
  sources: FileStack,
}
const reasons: Record<string, { status: string; help: string }> = {
  HISTORICAL_AGENTS_SNAPSHOT: { status: 'historical', help: 'historical' },
  HISTORICAL_AGENTS_PARTIAL: { status: 'historicalPartial', help: 'historicalPartial' },
  HISTORICAL_AGENT_READER_UNAVAILABLE: { status: 'unreadable', help: 'agentsUnavailable' },
  ORIGINAL_RUNTIME_REFERENCE_REQUIRED: { status: 'notSelected', help: 'runtimeNotSelected' },
  ORIGINAL_ACCEPTED_TASK_REFERENCE_REQUIRED: { status: 'notSelected', help: 'taskCapabilityScopeNotSelected' },
  TASK_WORKSPACE_RUNTIME_REFERENCE_NOT_SELECTED: {
    status: 'notSelected',
    help: 'runtimeNotSelected',
  },
  TASK_WORKSPACE_SCOPE_UNCONFIRMED: { status: 'unreadable', help: 'taskCapabilityScopeUnavailable' },
  TASK_WORKSPACE_SCOPE_TIMEOUT: { status: 'unreadable', help: 'taskCapabilityScopeUnavailable' },
  TASK_WORKSPACE_RUNTIME_UNCONFIRMED: { status: 'unreadable', help: 'runtimeUnavailable' },
  ORIGINAL_GOAL_ID_UNAVAILABLE: { status: 'missingIdentity', help: 'goalIdentity' },
  NATIVE_GOAL_UNREADABLE: { status: 'unreadable', help: 'goalUnavailable' },
  NATIVE_WORKFLOW_OBSERVATION_UNREADABLE: { status: 'unreadable', help: 'workflowsUnavailable' },
  NATIVE_ARTIFACT_OBSERVATION_UNREADABLE: { status: 'unreadable', help: 'artifactsUnavailable' },
  OFFICE_DISABLED: { status: 'disabled', help: 'artifactsDisabled' },
}

/** Format observed facts without turning unreadable counts into zero. */
export function TaskObservationOverview({
  snapshot,
  statusLabel,
  actions,
}: {
  snapshot: TaskWorkspaceSnapshot
  statusLabel: string
  actions?: ReactNode
}) {
  const { t, i18n } = useTranslation('taskWorkspace')
  return (
    <section className="studio-card-spacing workbench-card space-y-5" aria-label={t('overview')}>
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <h2 className="break-words text-lg font-medium text-text-primary">
            {snapshot.thread.title}
          </h2>
          <p className="inline-flex items-center gap-2 rounded-md bg-surface px-2.5 py-1 text-xs text-text-secondary">
            <span>{t('status')}</span>
            <span className="size-1 rounded-full bg-text-muted/60" aria-hidden="true" />
            <span
              className="font-medium text-text-primary"
              data-testid="task-workspace-root-status"
              data-native-status={snapshot.thread.nativeStatus}
            >
              {statusLabel}
            </span>
          </p>
        </div>
        {actions}
      </header>
      <div className="studio-card overflow-hidden rounded-xl border border-border/60">
        <div
          aria-hidden="true"
          className="grid grid-cols-[minmax(0,1fr)_4rem_8rem] items-center gap-3 border-b border-border/60 bg-surface/60 px-4 py-2.5 text-xs text-text-secondary sm:grid-cols-[minmax(0,1fr)_6rem_10rem]"
        >
          <span>{t('overviewCategory')}</span>
          <span className="text-right">{t('overviewCount')}</span>
          <span className="text-right">{t('overviewAvailability')}</span>
        </div>
        <dl className="divide-y divide-border/50">
          {snapshot.facets.map(facet => {
            const Icon = icons[facet.kind]
            const reason = facet.reasonCode ? reasons[facet.reasonCode] : undefined
            const status = reason
              ? t(`facetStatus.${reason.status}`)
              : facet.availability === 'available' && facet.observedCount === 0
                ? t('facetStatus.empty')
                : t(`availability.${facet.availability}`)
            return (
              <div
                key={facet.kind}
                data-testid={`task-workspace-facet-${facet.kind}`}
                className="grid min-h-14 grid-cols-[minmax(0,1fr)_4rem_8rem] items-center gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_6rem_10rem]"
              >
                <dt className="flex min-w-0 items-start gap-2.5 text-sm text-text-primary">
                  <Icon className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block truncate">{t(`facets.${facet.kind}`)}</span>
                    {reason && (
                      <span className="mt-1 block text-xs text-text-secondary">
                        {t(`facetHelp.${reason.help}`)}
                      </span>
                    )}
                  </span>
                </dt>
                <dd className="text-right text-sm font-medium tabular-nums text-text-primary">
                  {facet.observedCount == null ? (
                    <>
                      <span aria-hidden="true" className="text-text-muted">
                        —
                      </span>
                      <span className="sr-only">{t('overviewCountUnknown')}</span>
                    </>
                  ) : (
                    facet.observedCount.toLocaleString(i18n.language)
                  )}
                </dd>
                <dd className="flex justify-end">
                  <span
                    className={`inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs ${facet.availability === 'unavailable' ? 'bg-warning/10 text-warning' : facet.availability === 'available' ? 'bg-accent-surface/70 text-text-secondary' : 'bg-surface text-text-muted'}`}
                  >
                    <Circle className="size-2 shrink-0 fill-current" aria-hidden="true" />
                    <span>{status}</span>
                  </span>
                </dd>
              </div>
            )
          })}
        </dl>
      </div>
    </section>
  )
}
