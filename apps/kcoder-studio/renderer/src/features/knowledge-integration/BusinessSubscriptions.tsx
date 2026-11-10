import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { WorkflowArguments } from '@/features/workflows/WorkflowArguments'
import { SimpleScheduledSubscription } from './SimpleScheduledSubscription'
import { AutomationApplicationSourcePicker } from './AutomationApplicationSourcePicker'
import { AutomationDeliveryPicker } from './AutomationDeliveryPicker'
import { AutomationConnectionSourcePicker } from './AutomationConnectionSourcePicker'
import type {
  AutomationSubscriptionDraft,
  AutomationConnectionEventSource,
} from '../../../../shared/generated/contracts'
import { formatAutomationTimestamp } from './time'
import { createRandomUuid } from '@/lib/random-id'
import { useDomainAction } from './useDomainAction'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ScheduleTimeInput } from '@/components/chat/ScheduleTimeInput'
import { zonedCronFromPreset, parseLocalTimeInput } from '@/components/chat/schedulePresets'
import type { AutomationTemplate } from '../../../../shared/generated/contracts'
import {
  type SelectedAutomationApplicationSource,
  KnowledgeOperationError,
  type KnowledgeIntegrationClient,
  type SelectedAutomationFiles,
} from './client'
import { AutomationFileSourcePicker } from './AutomationFileSourcePicker'
import type { NativeAutomationFileInputs } from './automationFileInputs'
import { fieldClass, OperationError, PageActions } from './shared'
import { useDomainPage } from './useDomainPage'
import { BusinessTemplateInputs, type SavedBusinessInputResource } from './BusinessTemplateInputs'
import { AutomationArtifactClaims } from './AutomationArtifactClaims'
import { SubscriptionRemoval } from './SubscriptionRemoval'
import { AutomationQuarantine } from './AutomationQuarantine'
import { verifyAdoptedPublicationInputs } from './adopted-publication-inputs'
import { NativeModelPolicyWorkspace } from '@/features/model-policies/NativeModelPolicyWorkspace'
import type { ModelPolicyTarget } from '@/kcoder/modelPolicies'
import type { IntegrationModelSelectionIntent } from '../../../../shared/generated/contracts'
import type { AutomationTaskDraft } from './client'
export interface SavedBusinessWorkflow {
  id: string
  title: string
  version: number
}
function SubscriptionForm({
  client,
  workflows,
  templates,
  sourceResources,
  fileInputs,
  modelPolicyTarget,
  refresh,
  creationWorkflow,
  workflowSchema,
  workflowInputs,
  onCreationBlocked,
  onCreated,
}: {
  client: KnowledgeIntegrationClient
  workflows: SavedBusinessWorkflow[]
  templates: AutomationTemplate[]
  sourceResources: SavedBusinessInputResource[]
  fileInputs?: NativeAutomationFileInputs
  modelPolicyTarget?: ModelPolicyTarget
  refresh: () => void
  creationWorkflow?: SavedBusinessWorkflow
  workflowSchema?: unknown
  workflowInputs?: string
  onCreated?: () => void
  onCreationBlocked?: (blocked: boolean) => void
}) {
  const { t, i18n } = useTranslation('knowledgeIntegration')
  const [id, setId] = useState(() => createRandomUuid())
  const [title, setTitle] = useState(creationWorkflow?.title ?? ''),
    [workflowKey, setWorkflowKey] = useState(
      creationWorkflow ? `${creationWorkflow.id}@${creationWorkflow.version}` : ''
    )
  const [mode, setMode] = useState<
      'once' | 'daily' | 'cron' | 'every' | 'files' | 'connection' | 'application'
    >('daily'),
    [localTime, setLocalTime] = useState('09:00'),
    [dateTime, setDateTime] = useState('')
  const [cronExpression, setCronExpression] = useState('0 9 * * *')
  const [everySeconds, setEverySeconds] = useState(3600)
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  )
  const [inputs, setInputs] = useState(workflowInputs ?? '{}')
  const [consent, setConsent] = useState(false),
    [preview, setPreview] = useState<{ identity: string; next?: number; timezone: string }>()
  const [open, setOpen] = useState(false)
  const [modelPolicyOpen, setModelPolicyOpen] = useState(false)
  const [modelSelection, setModelSelection] = useState<IntegrationModelSelectionIntent>()
  const [fileSource, setFileSource] = useState<SelectedAutomationFiles>()
  const [delivery, setDelivery] = useState<AutomationSubscriptionDraft['delivery'] | undefined>({
    kind: 'studio',
  })
  const [applicationSource, setApplicationSource] = useState<SelectedAutomationApplicationSource>()
  const [connectionSource, setConnectionSource] = useState<AutomationConnectionEventSource>()
  const formGeneration = useRef(0)
  const action = useDomainAction(refresh, client)
  useEffect(() => {
    onCreationBlocked?.(action.blocked)
    return () => onCreationBlocked?.(false)
  }, [action.blocked, onCreationBlocked])
  const choices = [
    ...templates.map(template => ({
      id: template.workflowId,
      title: template.title,
      version: template.workflowVersion,
    })),
    ...workflows,
  ]
  const selectedTemplate = templates.find(
    template => `${template.workflowId}@${template.workflowVersion}` === workflowKey
  )
  const makeDraft = (): AutomationTaskDraft => {
    const workflow = choices.find(w => `${w.id}@${w.version}` === workflowKey)
    if (!workflow || !title.trim()) throw new KnowledgeOperationError('KNOWLEDGE_INVALID_PAYLOAD')
    const parsed: unknown = JSON.parse(inputs)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new KnowledgeOperationError('AUTOMATION_INVALID_INPUTS')
    const time = parseLocalTimeInput(localTime)
    const schedule =
      mode === 'once'
        ? { kind: 'at' as const, at: new Date(dateTime).toISOString() }
        : mode === 'cron'
          ? { kind: 'zoned_cron' as const, expression: cronExpression, timezone }
          : mode === 'every' && Number.isSafeInteger(everySeconds) && everySeconds > 0
            ? { kind: 'every' as const, every_seconds: everySeconds }
            : mode === 'daily' && time
              ? zonedCronFromPreset('daily', time, timezone)
              : null
    if (
      mode === 'files'
        ? !fileSource
        : mode === 'connection'
          ? connectionSource?.state !== 'available'
          : mode === 'application'
            ? applicationSource?.owner !== client
            : !schedule
    )
      throw new KnowledgeOperationError('AUTOMATION_INVALID_SCHEDULE')
    if (!delivery) throw new KnowledgeOperationError('AUTOMATION_DELIVERY_DESTINATION_REQUIRED')
    return {
      id,
      title,
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      ...(modelSelection ? { modelSelection } : {}),
      inputs: parsed,
      schedule:
        mode === 'files' || mode === 'connection' || mode === 'application' ? null : schedule,
      eventSource:
        mode === 'files'
          ? fileSource!.sourceRef
          : mode === 'connection'
            ? connectionSource!.sourceRef
            : mode === 'application'
              ? applicationSource!.sourceRef
              : null,
      maximumTokens: selectedTemplate?.maximumTokens ?? 1_000_000,
      maximumRuntimeSeconds: selectedTemplate?.maximumRuntimeSeconds ?? 300,
      delivery,
    }
  }
  const invalidate = () => {
    ++formGeneration.current
    setPreview(undefined)
    setConsent(false)
  }
  return (
    <details
      open={!!creationWorkflow}
      className="studio-card-spacing workbench-card"
      onToggle={event => {
        setOpen(event.currentTarget.open)
        if (!event.currentTarget.open) invalidate()
      }}
    >
      <summary className="cursor-pointer font-medium" data-testid="subscription-form-toggle">
        {t('newSubscription')}
      </summary>
      <form
        className="mt-4 space-y-4"
        onChange={invalidate}
        onSubmit={e => {
          e.preventDefault()
          void action.run(async () => {
            const draft = makeDraft()
            if (!consent || !preview || preview.identity !== JSON.stringify(draft))
              throw new KnowledgeOperationError('AUTOMATION_EXPLICIT_CONSENT_REQUIRED')
            await client.saveSubscription(draft)
            onCreated?.()
            setTitle('')
            setId(createRandomUuid())
            invalidate()
          })
        }}
      >
        <fieldset disabled={action.pending} className="space-y-4">
          <legend className="sr-only">{t('newSubscription')}</legend>
          {modelPolicyTarget && (
            <details onToggle={event => setModelPolicyOpen(event.currentTarget.open)}>
              <summary
                className="min-h-11 cursor-pointer py-2 text-sm font-medium"
                data-testid="subscription-model-policy-toggle"
              >
                {t('automationModelPolicy')}
              </summary>
              <p className="py-2 text-sm text-text-secondary">
                {t(modelSelection ? 'automationModelAutoSelected' : 'automationModelInherit')}
              </p>
              {modelSelection && (
                <Button
                  type="button"
                  variant="outline"
                  data-testid="subscription-model-inherit"
                  onClick={() => {
                    setModelSelection(undefined)
                    invalidate()
                  }}
                >
                  {t('automationUseCurrentModel')}
                </Button>
              )}
              {modelPolicyOpen && (
                <NativeModelPolicyWorkspace
                  target={{ ...modelPolicyTarget, requiredCapability: 'automationTaskModelsV1' }}
                  value={modelSelection}
                  allowEdit={false}
                  onSelect={selection => {
                    setModelSelection(selection)
                    invalidate()
                  }}
                />
              )}
            </details>
          )}
          {!creationWorkflow && templates.length > 0 && (
            <label className="block space-y-1 text-sm">
              <span>{t('businessTemplate')}</span>
              <SettingsSelect
                className={fieldClass}
                defaultValue=""
                onChange={event => {
                  const template = templates.find(item => item.id === event.target.value)
                  if (!template) return
                  setWorkflowKey(`${template.workflowId}@${template.workflowVersion}`)
                  setTitle(template.title)
                  if (template.suggestedSchedule.kind === 'zoned_cron') {
                    setTimezone(template.suggestedSchedule.timezone)
                    setCronExpression(template.suggestedSchedule.expression)
                    setMode('cron')
                  }
                  setInputs(
                    JSON.stringify(
                      {
                        period: '',
                        asOfDate: new Date().toISOString().slice(0, 10),
                        sourceRefs: [],
                        outputLanguage: i18n?.resolvedLanguage?.startsWith('zh') ? 'zh-CN' : 'en',
                        requirements: '',
                      },
                      null,
                      2
                    )
                  )
                  invalidate()
                }}
                disabled={action.blocked}
                data-testid="subscription-template"
              >
                <option value="">{t('chooseTemplate')}</option>
                {templates.map(template => (
                  <option key={template.id} value={template.id}>
                    {template.title}
                  </option>
                ))}
              </SettingsSelect>
            </label>
          )}
          <label className="block space-y-1 text-sm">
            <span>{t('titleLabel')}</span>
            <input
              className={fieldClass}
              value={title}
              onChange={e => setTitle(e.target.value)}
              required
              disabled={action.blocked}
              data-testid="subscription-title"
            />
          </label>
          {!creationWorkflow && (
            <label className="block space-y-1 text-sm">
              <span>{t('workflow')}</span>
              <SettingsSelect
                className={fieldClass}
                value={workflowKey}
                onChange={e => setWorkflowKey(e.target.value)}
                required
                disabled={action.blocked}
                data-testid="subscription-workflow"
              >
                <option value="">{t('workflow')}</option>
                {choices.map(w => (
                  <option key={`${w.id}@${w.version}`} value={`${w.id}@${w.version}`}>
                    {w.title} · v{w.version}
                  </option>
                ))}
              </SettingsSelect>
            </label>
          )}

          {!choices.length && <p className="text-sm text-text-muted">{t('noWorkflows')}</p>}
          <label className="block space-y-1 text-sm">
            <span>{t('triggerCondition')}</span>
            <SettingsSelect
              className={fieldClass}
              value={mode}
              onChange={e => {
                setMode(e.target.value as typeof mode)
                setFileSource(undefined)
                setConnectionSource(undefined)
                setApplicationSource(undefined)
              }}
              disabled={action.blocked}
              data-testid="subscription-schedule-mode"
            >
              <option value="daily">{t('daily')}</option>
              <option value="once">{t('once')}</option>
              <option value="cron">{t('cronSchedule')}</option>
              <option value="every">{t('everySchedule')}</option>
              <option value="files">{t('fileTrigger')}</option>
              <option value="connection">{t('connectionEventTrigger')}</option>
              <option value="application">{t('applicationResourceTrigger')}</option>
            </SettingsSelect>
          </label>
          {mode === 'application' ? (
            <AutomationApplicationSourcePicker
              client={client}
              value={applicationSource}
              disabled={action.blocked}
              onSelection={source => {
                setApplicationSource(source)
                invalidate()
              }}
            />
          ) : mode === 'connection' ? (
            <AutomationConnectionSourcePicker
              client={client}
              value={connectionSource}
              disabled={action.blocked}
              onSelection={source => {
                setConnectionSource(source)
                invalidate()
              }}
            />
          ) : mode === 'files' ? (
            <AutomationFileSourcePicker
              client={client}
              provider={fileInputs}
              active={open}
              disabled={action.blocked}
              onSelection={value => {
                setFileSource(value)
                invalidate()
              }}
            />
          ) : mode === 'cron' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span>{t('cronExpression')}</span>
                <input
                  className={fieldClass}
                  value={cronExpression}
                  onChange={event => setCronExpression(event.target.value)}
                  data-testid="subscription-cron"
                  required
                />
              </label>
              <label className="space-y-1 text-sm">
                <span>{t('timezone')}</span>
                <input
                  className={fieldClass}
                  value={timezone}
                  onChange={event => setTimezone(event.target.value)}
                  data-testid="subscription-cron-timezone"
                  required
                />
              </label>
            </div>
          ) : mode === 'every' ? (
            <label className="block space-y-1 text-sm">
              <span>{t('everySeconds')}</span>
              <input
                type="number"
                min={1}
                step={1}
                className={fieldClass}
                value={everySeconds}
                onChange={event => setEverySeconds(Number(event.target.value))}
                data-testid="subscription-every-seconds"
                required
              />
            </label>
          ) : mode === 'once' ? (
            <div className="space-y-1">
              <p className="text-sm">
                {t('at')} · {Intl.DateTimeFormat().resolvedOptions().timeZone}
              </p>
              <ScheduleTimeInput
                type="datetime-local"
                value={dateTime}
                onChange={value => {
                  setDateTime(value)
                  invalidate()
                }}
                testId="subscription-datetime"
              />
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-1">
                <p className="text-sm">{t('time')}</p>
                <ScheduleTimeInput
                  type="time"
                  value={localTime}
                  onChange={value => {
                    setLocalTime(value)
                    invalidate()
                  }}
                  testId="subscription-time"
                />
              </div>
              <label className="min-w-0 flex-1 space-y-1 text-sm">
                <span>{t('timezone')}</span>
                <input
                  className={fieldClass}
                  value={timezone}
                  onChange={e => setTimezone(e.target.value)}
                  required
                  disabled={action.blocked}
                  data-testid="subscription-timezone"
                />
              </label>
            </div>
          )}
          {selectedTemplate && (
            <div className="studio-card-spacing rounded-xl border border-border text-sm">
              <h4 className="font-medium">{t('acceptanceCriteria')}</h4>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {selectedTemplate.acceptanceCriteria.map(item => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <p className="mt-2 text-text-muted">{t('templateInputHint')}</p>
            </div>
          )}
          {creationWorkflow && workflowSchema != null && (
            <WorkflowArguments schema={workflowSchema} value={inputs} onChange={setInputs} />
          )}
          {selectedTemplate && (
            <BusinessTemplateInputs
              client={client}
              active={open}
              value={inputs}
              resources={sourceResources}
              disabled={action.blocked}
              onChange={setInputs}
            />
          )}
          <details>
            <summary
              className="cursor-pointer text-sm text-text-secondary"
              data-testid="subscription-limits-toggle"
            >
              {t('advancedSubscriptions')}
            </summary>
            <details>
              <summary
                className="cursor-pointer text-sm text-text-secondary"
                data-testid="subscription-inputs-toggle"
              >
                {t('inputs')}
              </summary>
              <textarea
                className={`${fieldClass} mt-2 font-mono`}
                value={inputs}
                onChange={e => setInputs(e.target.value)}
                rows={4}
                disabled={action.blocked}
                data-testid="subscription-inputs"
                aria-label={t('inputs')}
              />
            </details>
            <AutomationDeliveryPicker
              client={client}
              value={delivery}
              disabled={action.blocked}
              onSelection={value => {
                setDelivery(value)
                invalidate()
              }}
            />
          </details>
          <Button
            type="button"
            variant="outline"
            disabled={
              action.blocked ||
              !delivery ||
              !choices.length ||
              (mode === 'files' && !fileSource) ||
              (mode === 'connection' && !connectionSource) ||
              (mode === 'application' && applicationSource?.owner !== client)
            }
            data-testid="subscription-preview"
            onClick={() =>
              void action.run(async () => {
                const draft = makeDraft()
                const generation = formGeneration.current
                if (selectedTemplate) {
                  const parsed = draft.inputs
                  const references =
                    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                      ? (parsed as Record<string, unknown>).sourceRefs
                      : undefined
                  if (!Array.isArray(references))
                    throw new KnowledgeOperationError('AUTOMATION_SOURCE_PROVIDER_UNAVAILABLE')
                  await verifyAdoptedPublicationInputs(client, references)
                }
                const result = await client.previewSubscription(draft)
                if (generation !== formGeneration.current) return
                if (
                  mode === 'files' || mode === 'connection'
                    ? result.nextFireAtMs != null
                    : typeof result.nextFireAtMs !== 'number'
                )
                  throw new KnowledgeOperationError('AUTOMATION_INVALID_SCHEDULE')
                const zone =
                  draft.schedule?.kind === 'zoned_cron'
                    ? draft.schedule.timezone
                    : Intl.DateTimeFormat().resolvedOptions().timeZone
                if (
                  mode !== 'files' &&
                  mode !== 'connection' &&
                  !(
                    typeof result.nextFireAtMs === 'number' &&
                    formatAutomationTimestamp(
                      result.nextFireAtMs,
                      i18n?.resolvedLanguage || i18n?.language || 'en',
                      zone
                    )
                  )
                )
                  throw new KnowledgeOperationError('AUTOMATION_INVALID_SCHEDULE')
                setPreview({
                  identity: JSON.stringify(draft),
                  next: result.nextFireAtMs ?? undefined,
                  timezone: zone,
                })
              })
            }
          >
            {t(
              mode === 'files'
                ? 'previewFileSubscription'
                : mode === 'connection'
                  ? 'previewConnectionSubscription'
                  : 'preview'
            )}
          </Button>
          {preview && (
            <p role="status" className="text-sm text-text-secondary">
              {mode === 'connection'
                ? t('connectionPreviewReady')
                : mode === 'files'
                  ? t('filePreviewReady')
                  : t('nextRun', {
                      time:
                        (preview.next === undefined
                          ? undefined
                          : formatAutomationTimestamp(
                              preview.next,
                              i18n?.resolvedLanguage || i18n?.language || 'en',
                              preview.timezone
                            )) ?? t('unknown'),
                    })}
            </p>
          )}
          <label className="flex min-h-11 items-start gap-2 text-sm">
            <Checkbox
              checked={consent}
              disabled={!preview || action.blocked}
              onChange={e => {
                e.stopPropagation()
                setConsent(e.target.checked)
              }}
              data-testid="subscription-consent"
            />
            <span>
              {t(
                mode === 'files'
                  ? 'fileSubscriptionConsent'
                  : mode === 'connection'
                    ? 'connectionSubscriptionConsent'
                    : 'consent'
              )}
            </span>
          </label>
          <OperationError error={action.error} onInspect={() => void action.inspect()} />
          <Button
            type="submit"
            disabled={action.blocked || !preview || !consent}
            data-testid="subscription-save"
          >
            {t('saveSubscription')}
          </Button>
        </fieldset>
      </form>
    </details>
  )
}
export function BusinessSubscriptions({
  client,
  workflows = [],
  templates = [],
  sourceResources = [],
  fileInputs,
  modelPolicyTarget,
  onOpenNativeTask,
  onOpenNativeRun,
  onOpenArtifacts,
  view = 'all',
  creationWorkflow,
  workflowSchema,
  workflowInputs,
  onCreationBlocked,
  onCreated,
}: {
  view?: 'all' | 'create' | 'manage' | 'inbox'
  creationWorkflow?: SavedBusinessWorkflow
  workflowSchema?: unknown
  workflowInputs?: string
  onCreated?: () => void
  onCreationBlocked?: (blocked: boolean) => void
  client: KnowledgeIntegrationClient
  workflows?: SavedBusinessWorkflow[]
  templates?: AutomationTemplate[]
  sourceResources?: SavedBusinessInputResource[]
  fileInputs?: NativeAutomationFileInputs
  modelPolicyTarget?: ModelPolicyTarget
  onOpenNativeTask?: (threadId: string) => void
  onOpenNativeRun?: (runId: string) => void
  onOpenArtifacts?: (runId: string) => void
}) {
  const { t, i18n } = useTranslation('knowledgeIntegration')
  const simpleTemplate = templates.find(
    item =>
      item.id === 'scheduled-review' &&
      item.workflowId === 'builtin-office-scheduled-review' &&
      item.workflowVersion === 1
  )
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const subscriptions = useDomainPage(client.ownerKey, (after, signal) =>
    view === 'inbox' || view === 'create'
      ? Promise.resolve({ items: [], nextCursor: null })
      : client.listSubscriptions(after, signal)
  )
  const runs = useDomainPage(client.ownerKey, (after, signal) =>
    view === 'create'
      ? Promise.resolve({ items: [], nextCursor: null })
      : client.listRuns(after, signal)
  )
  const action = useDomainAction(() => {
    subscriptions.refresh()
    runs.refresh()
  }, client)
  return (
    <section className="space-y-5" data-testid="business-subscriptions">
      <p className="text-sm text-text-secondary">{t('automationHint')}</p>
      {(view === 'all' || view === 'create') && (
        <>
          {simpleTemplate && !creationWorkflow ? (
            <>
              <SimpleScheduledSubscription
                key={client.ownerKey}
                client={client}
                template={simpleTemplate}
                refresh={subscriptions.refresh}
              />
              <details onToggle={event => setAdvancedOpen(event.currentTarget.open)}>
                <summary
                  className="cursor-pointer text-sm text-text-secondary"
                  data-testid="advanced-workflow-subscriptions"
                >
                  {t('advancedSubscriptions')}
                </summary>
                {advancedOpen && (
                  <SubscriptionForm
                    onCreationBlocked={onCreationBlocked}
                    onCreated={onCreated}
                    creationWorkflow={creationWorkflow}
                    workflowSchema={workflowSchema}
                    workflowInputs={workflowInputs}
                    key={client.ownerKey}
                    client={client}
                    workflows={workflows}
                    templates={templates}
                    sourceResources={sourceResources}
                    fileInputs={fileInputs}
                    modelPolicyTarget={modelPolicyTarget}
                    refresh={subscriptions.refresh}
                  />
                )}
              </details>
            </>
          ) : (
            <SubscriptionForm
              onCreationBlocked={onCreationBlocked}
              onCreated={onCreated}
              creationWorkflow={creationWorkflow}
              workflowSchema={workflowSchema}
              workflowInputs={workflowInputs}
              key={client.ownerKey}
              client={client}
              workflows={workflows}
              templates={templates}
              sourceResources={sourceResources}
              fileInputs={fileInputs}
              modelPolicyTarget={modelPolicyTarget}
              refresh={subscriptions.refresh}
            />
          )}
        </>
      )}
      {(view === 'all' || view === 'manage') && (
        <>
          <OperationError
            error={action.error ?? subscriptions.error ?? runs.error}
            onInspect={() => void action.inspect()}
          />
          <div className="space-y-3" aria-busy={subscriptions.pending}>
            {subscriptions.items.map(sub => (
              <div
                key={`${sub.draft.id}-${sub.revision}`}
                className="studio-card-spacing workbench-card workbench-card-interactive flex flex-wrap items-center gap-3"
                data-testid="subscription-row"
              >
                <div className="mr-auto min-w-0">
                  <h3 className="font-medium">{sub.draft.title}</h3>
                  <p className="text-sm text-text-muted">
                    {t(sub.enabled ? 'enabled' : 'disabled')} ·{' '}
                    {workflows.find(
                      workflow =>
                        workflow.id === sub.draft.workflowId &&
                        workflow.version === sub.draft.workflowVersion
                    )?.title ?? t('workflow')}{' '}
                    v{sub.draft.workflowVersion}
                  </p>
                  <p className="text-xs text-text-muted" data-testid="subscription-trigger">
                    {t(
                      sub.draft.eventSource?.startsWith('connection-event-')
                        ? 'connectionEventTrigger'
                        : sub.draft.eventSource
                          ? 'fileTrigger'
                          : 'schedule'
                    )}
                  </p>
                  {sub.nextFireAtMs && (
                    <p className="text-xs text-text-muted">
                      {t('nextRun', {
                        time:
                          formatAutomationTimestamp(
                            sub.nextFireAtMs,
                            i18n?.resolvedLanguage || i18n?.language || 'en',
                            sub.draft.schedule?.kind === 'zoned_cron'
                              ? sub.draft.schedule.timezone
                              : undefined
                          ) ?? t('unknown'),
                      })}
                    </p>
                  )}
                </div>
                <Button
                  variant="outline"
                  disabled={action.blocked}
                  onClick={() =>
                    void action.run(() => client.setSubscriptionEnabled(sub, !sub.enabled))
                  }
                  data-testid="subscription-toggle"
                >
                  {t(sub.enabled ? 'disable' : 'enable')}
                </Button>

                <SubscriptionRemoval
                  key={`${client.ownerKey}-${sub.draft.id}-${sub.revision}`}
                  client={client}
                  subscription={sub}
                  refresh={subscriptions.refresh}
                />
              </div>
            ))}
          </div>
          <PageActions {...subscriptions} />
          <AutomationQuarantine key={client.ownerKey} client={client} />
        </>
      )}
      {(view === 'all' || view === 'inbox' || view === 'manage') && (
        <div className="border-t border-border pt-5">
          <h3 className="mb-3 font-medium">{t('inbox')}</h3>
          {view !== 'manage' && (
            <OperationError
              error={action.error ?? runs.error}
              onInspect={() => void action.inspect()}
            />
          )}
          <div className="space-y-3" aria-busy={runs.pending}>
            {runs.items.map(run => (
              <details key={run.id} className="studio-card-spacing workbench-card" data-testid="automation-run">
                <summary className="cursor-pointer font-medium">
                  {run.title ||
                    subscriptions.items.find(sub => sub.draft.id === run.subscriptionId)?.draft
                      .title ||
                    t('history')}
                </summary>
                <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-text-muted">{t('execution')}</dt>
                    <dd>{t(`runState.${run.status}`)}</dd>
                  </div>
                  <div>
                    <dt className="text-text-muted">{t('delivery')}</dt>
                    <dd>{t(`deliveryState.${run.deliveryStatus}`)}</dd>
                  </div>
                </dl>
                {run.errorCode === 'AUTOMATION_BUDGET_EXHAUSTED' && (
                  <p
                    role="alert"
                    className="mt-3 text-sm text-destructive"
                    data-testid="automation-budget-exhausted"
                  >
                    {t('automationBudgetExhausted')}
                  </p>
                )}
                {run.output && (
                  <div className="mt-3 space-y-1">
                    <p className="text-sm text-text-muted">{t('output')}</p>
                    <div className="whitespace-pre-wrap text-base">{run.output}</div>
                  </div>
                )}
                {run.artifactRefs.length > 0 && (
                  <div>
                    <p className="mt-2 text-sm text-text-muted">
                      {t('artifacts', { count: run.artifactRefs.length })}
                    </p>
                    <AutomationArtifactClaims client={client} runId={run.id} />
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {['accepted', 'running', 'waiting', 'unknown'].includes(run.status) &&
                    run.nativeThreadId && (
                      <Button
                        variant="outline"
                        disabled={action.blocked}
                        onClick={() => void action.run(() => client.cancelRun(run))}
                        data-testid="automation-cancel-run"
                      >
                        {t('cancelRun')}
                      </Button>
                    )}
                  {run.deliveryId && ['pending', 'unknown'].includes(run.deliveryStatus) && (
                    <>
                      <Button
                        variant="outline"
                        disabled={action.blocked}
                        onClick={() => void action.run(() => client.controlDelivery(run, 'cancel'))}
                        data-testid="automation-cancel-delivery"
                      >
                        {t('cancelDelivery')}
                      </Button>
                      <Button
                        variant="outline"
                        disabled={action.blocked}
                        onClick={() =>
                          void action.run(() => client.controlDelivery(run, 'reconcile'))
                        }
                        data-testid="automation-reconcile-delivery"
                      >
                        {t('reconcileDelivery')}
                      </Button>
                    </>
                  )}

                  {run.nativeThreadId &&
                    (onOpenNativeTask || (run.nativeTaskId && onOpenNativeRun)) && (
                      <Button
                        variant="outline"
                        onClick={() =>
                          run.nativeTaskId && onOpenNativeRun
                            ? onOpenNativeRun(run.id)
                            : onOpenNativeTask?.(run.nativeThreadId!)
                        }
                        data-testid="automation-open-native-task"
                      >
                        {t('openNativeTask')}
                      </Button>
                    )}
                  {!!run.artifactRefs.length && onOpenArtifacts && (
                    <Button
                      variant="outline"
                      onClick={() => onOpenArtifacts(run.id)}
                      data-testid="automation-open-artifacts"
                    >
                      {t('openArtifacts')}
                    </Button>
                  )}
                </div>
                <Button
                  variant="ghost"
                  className="mt-3"
                  disabled={action.blocked}
                  onClick={() => void action.run(() => client.hideRun(run))}
                  data-testid="automation-hide-run"
                >
                  {t('hide')}
                </Button>
              </details>
            ))}
          </div>
          <PageActions {...runs} />
        </div>
      )}
    </section>
  )
}
