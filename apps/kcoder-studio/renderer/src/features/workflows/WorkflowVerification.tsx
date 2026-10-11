import { FrozenModelConfigurationDetails } from '@/components/chat/composer/FrozenModelConfigurationDetails'
import { isWorkflowAgentConfigurationSummary } from '../../../../shared/generated/contracts'
import type {
  ModelConfigurationSummary,
  WorkflowAgentConfigurationSummary,
} from '../../../../shared/generated/contracts'
import { Button } from '@/components/ui/button'
import { DisclosureSection } from '@/components/ui/disclosure-section'
import { StatusChip } from '@/components/settings/settings-ui'
import {
  CheckCircle2,
  ChevronRight,
  Layers,
  MessageSquare,
  ShieldCheck,
  Workflow,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

export interface WorkflowStaticVerification {
  savedVersion: number
  definitionSha256: string
  checkedAtMs: number
  checkedNodes: string[]
  checks: string[]
  toolContracts: string
  toolContractDetails?: {
    knownNodes: string[]
    unknownNodes: string[]
    runtimeBoundNodes: string[]
  } | null
}
export interface WorkflowRuntimeVerification {
  definitionId: string
  savedVersion: number
  definitionSha256: string
  runId: string
  resumeCount: number
  artifactAttempt?: number | null
  outcomeCertainty?: string
  startedAtMs: number
  updatedAtMs: number
  executionStatus: string
  checkStatus: string
  scope: string
  checkedNodes: string[]
  skippedNodes: string[]
  inputSha256: string
  privateInputRef: string
  outputSha256?: string | null
  privateOutputRef?: string | null
  modelSnapshot: {
    model?: string
    provider?: string | null
    reasoningEffort?: string | null
    configuration?: ModelConfigurationSummary | null
    selectionSource?: string
    agentsIncomplete?: boolean
    agents?: WorkflowAgentConfigurationSummary[]
  }
  safetySha256?: string | null
  interactionModified: boolean
  scenario?: {
    request: { id: string; requiredCheckNodes: string[]; expectedSkippedNodes?: string[] | null }
    status: string
    scope: string
  } | null
}
export interface WorkflowVersionVerification {
  definitionId: string
  savedVersion: number
  draftStatus: string
  availability?: string
  staticCheck?: WorkflowStaticVerification | null
  runs: WorkflowRuntimeVerification[]
  totalRunCount?: number
  nextOffset?: number | null
}
export interface WorkflowStorageCapacity {
  backend: string
  workflowCount: number
  workflowLimit: number
  savedVersionCount: number
  savedVersionBytes?: number
  versionBytes?: Record<string, number>
  backupBytes?: number
  backupByteLimit?: number
  historyBytes?: number
  historyByteLimit?: number
  versionsPerWorkflowLimit: number
  usedBytes: number
  byteLimit: number
  nearLimit: boolean
  versions: Record<string, number>
}

export function WorkflowVerification({
  definitionId,
  version,
  verification,
  capacity,
  loading = false,
  unsupported = false,
  error,
  disabled = false,
  onPrepareVerification,
  onLoadMore,
}: {
  definitionId: string
  version: number | null
  verification?: WorkflowVersionVerification | null
  capacity?: WorkflowStorageCapacity | null
  loading?: boolean
  unsupported?: boolean
  error?: string
  disabled?: boolean
  /** Opens the existing input/target review flow; it must not silently launch execution. */
  onPrepareVerification?: () => void
  onLoadMore?: () => void
}) {
  const { t } = useTranslation('common')
  const matches =
    verification?.definitionId === definitionId &&
    verification.savedVersion === version &&
    (!verification.staticCheck || verification.staticCheck.savedVersion === version)
  const evidence = matches ? verification : null
  const mismatched = !!verification && !matches
  const runs = evidence?.runs ?? []
  const statuses = new Set(['not_requested', 'pending', 'passed', 'failed', 'incomplete'])
  return (
    <section className="space-y-4 text-sm" data-testid="workflow-verification" aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border/60 bg-background p-5">
        <div className="flex min-w-0 items-start gap-4">
          <span
            aria-hidden="true"
            className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent-surface text-focus"
          >
            <Layers className="size-5" />
          </span>
          <div className="min-w-0 space-y-1">
            <p className="text-sm text-text-secondary">{t('workflowVerification.title')}</p>
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-lg font-medium">
                {version === null
                  ? t('workflowVerification.unsaved')
                  : t(
                      evidence?.availability === 'archived_history'
                        ? 'workflowVerification.archivedVersion'
                        : 'workflowVerification.savedVersion',
                      { version }
                    )}
              </p>
              {evidence?.staticCheck && (
                <StatusChip variant="success">{t('workflowVerification.staticStatus')}</StatusChip>
              )}
            </div>
            <p className="text-text-secondary">
              {t(
                evidence?.staticCheck
                  ? 'workflowVerification.staticPassed'
                  : 'workflowVerification.staticUnrecorded'
              )}
            </p>
          </div>
        </div>
        {version !== null &&
          evidence?.availability !== 'archived_history' &&
          onPrepareVerification && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={disabled || loading}
              onClick={onPrepareVerification}
              data-testid="workflow-prepare-verification"
            >
              <CheckCircle2 aria-hidden="true" />
              {t('workflowVerification.prepare')}
              <ChevronRight className="ml-8" aria-hidden="true" />
            </Button>
          )}
      </div>
      {error && <p role="alert">{error}</p>}
      {mismatched && <p role="alert">{t('workflowVerification.versionMismatch')}</p>}
      {unsupported && <p>{t('workflowVerification.unsupported')}</p>}
      {version === null && <p>{t('workflowVerification.unsaved')}</p>}
      {evidence?.draftStatus === 'new_draft_unverified' && (
        <p data-testid="workflow-new-draft-unverified">{t('workflowVerification.newDraft')}</p>
      )}
      {version !== null && !unsupported && !loading && !mismatched && (
        <div className="space-y-3">
          {['not_checked', 'partially_checked'].includes(
            evidence?.staticCheck?.toolContracts ?? ''
          ) && <p>{t('workflowVerification.toolContractsUnverified')}</p>}
          {evidence?.staticCheck && (
            <DisclosureSection
              testId="workflow-static-coverage"
              title={t('workflowVerification.staticTitle')}
              description={t('workflowVerification.staticDescription')}
              icon={<ShieldCheck />}
              status={
                <StatusChip variant="success">{t('workflowVerification.staticStatus')}</StatusChip>
              }
              defaultOpen
              inlineDescription
            >
              <div className="space-y-3 rounded-xl border border-border/60 bg-background p-4">
                <p className="sr-only">
                  {t('workflowVerification.checkedNodes', {
                    nodes: evidence.staticCheck.checkedNodes.join(', '),
                  })}
                </p>
                <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
                  <span className="font-medium">{t('workflowVerification.checkedNodesLabel')}</span>
                  <div className="flex flex-wrap gap-2">
                    {evidence.staticCheck.checkedNodes.map(node => (
                      <span
                        key={node}
                        className="rounded-md bg-surface px-2 py-1 text-xs text-text-secondary"
                      >
                        {node}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
                  <span className="font-medium">{t('workflowVerification.checksLabel')}</span>
                  <p className="leading-relaxed text-text-secondary">
                    {evidence.staticCheck.checks
                      .map(check => t(`workflowVerification.staticChecks.${check}`))
                      .join(', ')}
                  </p>
                </div>
              </div>
            </DisclosureSection>
          )}
          {!runs.length && !(evidence?.totalRunCount ?? 0) && (
            <p>{t('workflowVerification.executionUnverified')}</p>
          )}
          {!runs.length && (evidence?.totalRunCount ?? 0) > 0 && (
            <p>{t('workflowVerification.historyElsewhere')}</p>
          )}
        </div>
      )}
      {runs.map(run => {
        const valid =
          run.definitionId === definitionId &&
          run.savedVersion === version &&
          run.scope === 'configured_result_checks' &&
          (!evidence?.staticCheck || evidence.staticCheck.definitionSha256 === run.definitionSha256)
        const checkStatus =
          valid &&
          statuses.has(run.checkStatus) &&
          (run.checkStatus !== 'passed' ||
            (run.executionStatus === 'completed' && run.checkedNodes.length > 0))
            ? run.checkStatus
            : 'incomplete'
        const scenario = run.scenario
        const requestedNodes = scenario?.request.requiredCheckNodes ?? []
        const expectedSkipped = scenario?.request.expectedSkippedNodes
        const matchesSkipped =
          expectedSkipped == null ||
          (expectedSkipped.length === new Set(expectedSkipped).size &&
            new Set(run.skippedNodes).size === expectedSkipped.length &&
            expectedSkipped.every(node => run.skippedNodes.includes(node)))
        const scenarioValid =
          valid &&
          scenario?.scope === 'declared_configured_checks' &&
          requestedNodes.length > 0 &&
          requestedNodes.length === new Set(requestedNodes).size &&
          (scenario.status !== 'passed' ||
            (checkStatus === 'passed' &&
              requestedNodes.every(node => run.checkedNodes.includes(node)) &&
              matchesSkipped))
        const scenarioStatus =
          scenario && scenarioValid && statuses.has(scenario.status)
            ? scenario.status
            : 'incomplete'
        const label = (status: string) =>
          status === 'passed' && run.interactionModified ? 'modified_passed' : status
        return (
          <div key={`${run.runId}:${run.artifactAttempt ?? run.resumeCount}`} className="space-y-4">
            <DisclosureSection
              testId={`workflow-run-evidence-${run.runId}`}
              title={t('workflowVerification.runTitle')}
              description={run.runId}
              icon={<Workflow />}
              status={
                <StatusChip
                  variant={
                    checkStatus === 'passed'
                      ? 'success'
                      : checkStatus === 'failed'
                        ? 'destructive'
                        : 'neutral'
                  }
                  className="max-w-64 whitespace-normal text-right"
                >
                  {t(`workflowVerification.check.${label(checkStatus)}`)}
                </StatusChip>
              }
              defaultOpen
              inlineDescription
            >
              <div className="space-y-3 rounded-xl border border-border/60 bg-background p-4 leading-relaxed">
                <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
                  <span className="font-medium">{t('workflowVerification.executionLabel')}</span>
                  <span className="flex items-center gap-2 text-text-secondary">
                    {run.executionStatus === 'completed' && (
                      <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
                    )}
                    {run.executionStatus}
                  </span>
                </div>
                {run.outcomeCertainty !== 'known' && (
                  <p>{t('workflowVerification.effectsUnknown')}</p>
                )}
                {valid && (
                  <>
                    <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
                      <span className="font-medium">{t('workflowVerification.scopeLabel')}</span>
                      <p className="text-text-secondary">{t('workflowVerification.scopeValue')}</p>
                    </div>
                    <p className="sr-only" data-testid={`workflow-checked-${run.runId}`}>
                      {t('workflowVerification.checkedNodes', {
                        nodes: run.checkedNodes.join(', ') || '—',
                      })}
                    </p>
                    <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
                      <span className="font-medium">
                        {t('workflowVerification.checkedNodesLabel')}
                      </span>
                      <div className="flex flex-wrap gap-2">
                        {run.checkedNodes.length
                          ? run.checkedNodes.map(node => (
                              <span
                                key={node}
                                className="rounded-md bg-surface px-2 py-1 text-xs text-text-secondary"
                              >
                                {node}
                              </span>
                            ))
                          : '—'}
                      </div>
                    </div>
                    <p className="sr-only">
                      {t('workflowVerification.skippedNodes', {
                        nodes: run.skippedNodes.join(', ') || '—',
                      })}
                    </p>
                    <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
                      <span className="font-medium">
                        {t('workflowVerification.skippedNodesLabel')}
                      </span>
                      <div className="flex flex-wrap gap-2">
                        {run.skippedNodes.length
                          ? run.skippedNodes.map(node => (
                              <span
                                key={node}
                                className="rounded-md bg-surface px-2 py-1 text-xs text-text-secondary"
                              >
                                {node}
                              </span>
                            ))
                          : '—'}
                      </div>
                    </div>
                    {scenario ? (
                      <>
                        <p>
                          {t('workflowVerification.scenario', {
                            id: scenario.request.id,
                            status: t(`workflowVerification.check.${label(scenarioStatus)}`),
                          })}
                        </p>
                        <p>
                          {t('workflowVerification.scenarioScope', {
                            nodes: requestedNodes.join(', '),
                          })}
                        </p>
                      </>
                    ) : (
                      <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
                        <span className="font-medium">{t('workflowVerification.notesLabel')}</span>
                        <p className="text-text-secondary">
                          {t('workflowVerification.scenarioUnrecorded')}
                        </p>
                      </div>
                    )}
                    {run.interactionModified && (
                      <p>{t('workflowVerification.interactionModified')}</p>
                    )}
                  </>
                )}
              </div>
            </DisclosureSection>
            {valid && (
              <DisclosureSection
                testId={`workflow-model-evidence-${run.runId}`}
                title={t('workflowVerification.modelConfiguration')}
                description={t('workflowVerification.modelConfigurationHelp')}
                icon={<MessageSquare />}
                defaultOpen
                inlineDescription
              >
                <div className="grid gap-3 lg:grid-cols-2">
                  <div className="min-w-0 space-y-3 rounded-xl border border-border/60 bg-background p-4">
                    <h3 className="font-medium">{t('workflowVerification.admissionSnapshot')}</h3>
                    <FrozenModelConfigurationDetails
                      configuration={run.modelSnapshot.configuration}
                      layout="table"
                    />
                    {run.modelSnapshot.model && !run.modelSnapshot.configuration && (
                      <p>{t('workflowVerification.model', { model: run.modelSnapshot.model })}</p>
                    )}
                  </div>
                  {(Array.isArray(run.modelSnapshot.agents)
                    ? run.modelSnapshot.agents.slice(0, 64)
                    : []
                  )
                    .filter(isWorkflowAgentConfigurationSummary)
                    .filter(
                      agent =>
                        agent.runId === run.runId &&
                        agent.artifactAttempt === (run.artifactAttempt ?? run.resumeCount)
                    )
                    .map(agent => (
                      <div
                        key={agent.agentId}
                        data-testid="workflow-agent-model-configuration"
                        className="min-w-0 space-y-3 rounded-xl border border-border/60 bg-background p-4"
                      >
                        <h3 className="font-medium">
                          {t(
                            agent.selectionSource === 'inherited_session'
                              ? 'workflowVerification.inheritedModel'
                              : 'workflowVerification.agentModel'
                          )}
                        </h3>
                        <FrozenModelConfigurationDetails
                          configuration={agent.configuration}
                          selectionSource={agent.selectionSource}
                          layout="table"
                        />
                        <p className="break-all text-xs text-text-muted">{agent.agentId}</p>
                      </div>
                    ))}
                </div>
                {run.modelSnapshot.agentsIncomplete === true && (
                  <p>{t('workflowVerification.agentSnapshotsIncomplete')}</p>
                )}
              </DisclosureSection>
            )}
          </div>
        )
      })}
      {evidence?.nextOffset != null && onLoadMore && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || loading}
          onClick={onLoadMore}
          data-testid="workflow-more-evidence"
        >
          {t('workflowVerification.moreRuns')}
        </Button>
      )}
      {capacity && (
        <details
          className="rounded-xl border border-border/60 p-4 text-text-muted"
          data-testid="workflow-library-capacity"
        >
          <summary
            data-testid="workflow-capacity-toggle"
            className="cursor-pointer focus-visible:ring-2 focus-visible:ring-focus"
          >
            {t('workflowVerification.capacityDetails')}
          </summary>
          <div className="mt-3 space-y-2">
            <p>
              {t('workflowVerification.workflowCapacity', {
                count: capacity.workflowCount,
                limit: capacity.workflowLimit,
              })}
            </p>
            <p>
              {t('workflowVerification.versionCapacity', {
                count: capacity.versions[definitionId] ?? 0,
                limit: capacity.versionsPerWorkflowLimit,
              })}
            </p>
            <p>
              {t('workflowVerification.byteCapacity', {
                used: capacity.usedBytes.toLocaleString(),
                limit: capacity.byteLimit.toLocaleString(),
              })}
            </p>
            {capacity.versionBytes?.[definitionId] !== undefined && (
              <p>
                {t('workflowVerification.versionBytes', {
                  bytes: capacity.versionBytes[definitionId]!.toLocaleString(),
                })}
              </p>
            )}
            {capacity.backupBytes !== undefined && capacity.backupByteLimit !== undefined && (
              <p>
                {t('workflowVerification.backupBytes', {
                  bytes: capacity.backupBytes.toLocaleString(),
                  limit: capacity.backupByteLimit.toLocaleString(),
                })}
              </p>
            )}
            {capacity.historyBytes !== undefined && capacity.historyByteLimit !== undefined && (
              <p>
                {t('workflowVerification.historyBytes', {
                  bytes: capacity.historyBytes.toLocaleString(),
                  limit: capacity.historyByteLimit.toLocaleString(),
                })}
              </p>
            )}
          </div>
        </details>
      )}
      {capacity?.nearLimit && (
        <p role="status" className="text-text-secondary">
          {t('workflowVerification.nearCapacity')}
        </p>
      )}
    </section>
  )
}
