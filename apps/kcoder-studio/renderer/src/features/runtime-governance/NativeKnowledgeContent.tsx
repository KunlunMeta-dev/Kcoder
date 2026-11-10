import { KnowledgeFeatureSetup } from './KnowledgeFeatureSetup'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  AutomationTemplate,
  IntegrationEntityRef,
} from '../../../../shared/generated/contracts'
import { KnowledgeIntegrationWorkspace } from '@/features/knowledge-integration/KnowledgeIntegrationWorkspace'
import {
  KnowledgeOperationError,
  type KnowledgeIntegrationClient,
} from '@/features/knowledge-integration/client'
import { OperationError } from '@/features/knowledge-integration/shared'
import { nativeWikiPublicationInputs } from './nativeWikiPublicationInputs'
import { nativeAutomationFileInputs } from './nativeAutomationFileInputs'
import { nativeAutomationWorkflows } from './nativeAutomationWorkflows'
import type { SavedBusinessWorkflow } from '@/features/knowledge-integration/BusinessSubscriptions'
import { TaskArtifactViewer } from '@/features/task-workspace/artifacts/TaskArtifactViewer'
import { nativeOfficeReadExport } from './nativeOfficeFiles'
import { WorkflowExecutionCanvas } from '@/features/workflows/WorkflowExecutionCanvas'
import { workflowApi } from '@/features/workflows/workflowApi'
import type { WorkflowReference } from '@/features/workflows/workflowReferences'

/** Load target metadata only when its section opens, under the same native owner. */
export function NativeKnowledgeContent({
  client,
  serverId,
  workspacePath,
  getProjectWorkspaceRoot,
  isCurrent,
  memoryTaskSnapshot,
  onReconnect,
  automationOnly = false,
  includeBuiltinTemplates = false,
  automationView = 'all',
  savedWorkflows,
  creationWorkflow,
  workflowSchema,
  workflowInputs,
  onCreationBlocked,
  onCreated,
}: {
  onReconnect: () => void
  includeBuiltinTemplates?: boolean
  automationOnly?: boolean
  automationView?: 'all' | 'create' | 'manage' | 'inbox'
  savedWorkflows?: SavedBusinessWorkflow[]
  creationWorkflow?: SavedBusinessWorkflow
  workflowSchema?: unknown
  workflowInputs?: string
  onCreated?: () => void
  onCreationBlocked?: (blocked: boolean) => void
  client: KnowledgeIntegrationClient
  serverId: string
  workspacePath?: string
  getProjectWorkspaceRoot?: (serverId: string) => Promise<string>
  isCurrent: () => boolean
  memoryTaskSnapshot?: { taskId: string; threadId: string }
}) {
  const { t, i18n } = useTranslation('knowledgeIntegration')
  const language = i18n?.resolvedLanguage || i18n?.language || 'en'
  const artifactOwner = JSON.stringify([client.ownerKey, serverId, workspacePath])
  const [automationAvailable, setAutomationAvailable] = useState(false)
  const markAutomationAvailable = useCallback(() => setAutomationAvailable(true), [])
  const [section, setSection] = useState<'memory' | 'knowledge' | 'automation'>(
    automationOnly ? 'automation' : 'memory'
  )
  const [revision, setRevision] = useState(0)
  const [artifacts, setArtifacts] = useState<{
    owner: string
    runId: string
    threadId: string
    workflowTaskId?: string
    references: IntegrationEntityRef[]
  }>()
  const [workflow, setWorkflow] = useState<{
    owner: string
    threadId: string
    reference: WorkflowReference
  }>()
  const [artifactFailure, setArtifactFailure] = useState<KnowledgeOperationError>()
  const artifactRequest = useRef<AbortController | undefined>(undefined)
  useEffect(
    () => () => {
      artifactRequest.current?.abort()
    },
    [artifactOwner, client]
  )
  const openArtifacts = (runId: string) => {
    artifactRequest.current?.abort()
    const cancel = new AbortController()
    artifactRequest.current = cancel
    setArtifactFailure(undefined)
    void Promise.all([
      client.readRun(runId, cancel.signal),
      client.readRunArtifacts(runId, cancel.signal),
    ])
      .then(([run, references]) => {
        if (cancel.signal.aborted || artifactRequest.current !== cancel || !isCurrent()) return
        if (
          run.id !== runId ||
          run.status !== 'completed' ||
          !run.nativeThreadId ||
          !references.length
        )
          throw new KnowledgeOperationError('AUTOMATION_RESULT_NOT_READY')
        if (!run.nativeTurnId && !run.nativeTaskId)
          throw new KnowledgeOperationError('AUTOMATION_RESULT_NOT_READY')
        setWorkflow(undefined)
        setArtifacts({
          owner: artifactOwner,
          runId,
          threadId: run.nativeThreadId,
          ...(run.nativeTaskId ? { workflowTaskId: run.nativeTaskId } : {}),
          references,
        })
      })
      .catch(error => {
        if (!cancel.signal.aborted && isCurrent())
          setArtifactFailure(
            error instanceof KnowledgeOperationError
              ? error
              : new KnowledgeOperationError('KNOWLEDGE_OPERATION_UNAVAILABLE')
          )
      })
  }
  const openNativeRun = (runId: string) => {
    artifactRequest.current?.abort()
    const cancel = new AbortController()
    artifactRequest.current = cancel
    setArtifactFailure(undefined)
    void client
      .readRun(runId, cancel.signal)
      .then(async run => {
        if (cancel.signal.aborted || artifactRequest.current !== cancel || !isCurrent()) return
        if (run.id !== runId || !run.nativeTaskId || !run.nativeThreadId)
          throw new KnowledgeOperationError('AUTOMATION_RESULT_NOT_READY')
        const observed = await workflowApi.run(serverId, run.nativeTaskId, undefined, {
          signal: cancel.signal,
          workspacePath,
        })
        if (cancel.signal.aborted || artifactRequest.current !== cancel || !isCurrent()) return
        if (
          observed.runId !== run.nativeTaskId ||
          observed.threadId !== run.nativeThreadId ||
          !observed.definitionId ||
          !Number.isSafeInteger(observed.version) ||
          observed.version! < 1 ||
          (workspacePath !== undefined && observed.workspace !== workspacePath)
        )
          throw new KnowledgeOperationError('AUTOMATION_RESULT_NOT_READY')
        setArtifacts(undefined)
        setWorkflow({
          owner: artifactOwner,
          threadId: run.nativeThreadId,
          reference: {
            id: observed.definitionId,
            version: observed.version!,
            runId: observed.runId,
            title: run.title || observed.definitionId,
          },
        })
      })
      .catch(error => {
        if (!cancel.signal.aborted && isCurrent())
          setArtifactFailure(
            error instanceof KnowledgeOperationError
              ? error
              : new KnowledgeOperationError('KNOWLEDGE_OPERATION_UNAVAILABLE')
          )
      })
  }
  const loadKey = JSON.stringify([
    client.ownerKey,
    language,
    revision,
    automationOnly,
    includeBuiltinTemplates,
  ])
  const [loaded, setLoaded] = useState<{
    key: string
    templates: AutomationTemplate[]
    workflows: SavedBusinessWorkflow[]
    failure?: KnowledgeOperationError
  }>()
  const templates = loaded?.key === loadKey ? loaded.templates : []
  const failure = loaded?.key === loadKey ? loaded.failure : undefined
  const workflows = loaded?.key === loadKey ? loaded.workflows : []
  const fileInputs = useMemo(
    () =>
      nativeAutomationFileInputs({
        ownerKey: client.ownerKey,
        serverId,
        workspacePath,
        isCurrent,
        getProjectWorkspaceRoot,
      }),
    [client.ownerKey, serverId, workspacePath, isCurrent, getProjectWorkspaceRoot]
  )
  const wikiInputs = useMemo(
    () => nativeWikiPublicationInputs(client.ownerKey, serverId, isCurrent),
    [client.ownerKey, serverId, isCurrent]
  )
  useEffect(() => {
    if (section !== 'automation' || !automationAvailable) return
    const cancel = new AbortController()
    void Promise.allSettled([
      automationOnly && !includeBuiltinTemplates
        ? Promise.resolve([])
        : client.listTemplates(language, cancel.signal),
      savedWorkflows
        ? Promise.resolve(savedWorkflows)
        : nativeAutomationWorkflows(serverId, isCurrent, cancel.signal, workspacePath),
    ]).then(([templateResult, workflowResult]) => {
      if (cancel.signal.aborted || !isCurrent()) return
      const cause =
        templateResult.status === 'rejected'
          ? templateResult.reason
          : workflowResult.status === 'rejected'
            ? workflowResult.reason
            : undefined
      setLoaded({
        key: loadKey,
        templates: templateResult.status === 'fulfilled' ? templateResult.value : [],
        workflows: workflowResult.status === 'fulfilled' ? workflowResult.value : [],
        ...(cause
          ? {
              failure:
                cause instanceof KnowledgeOperationError
                  ? cause
                  : new KnowledgeOperationError('KNOWLEDGE_OPERATION_UNAVAILABLE'),
            }
          : {}),
      })
    })
    return () => cancel.abort()
  }, [
    client,
    language,
    section,
    loadKey,
    serverId,
    isCurrent,
    automationAvailable,
    savedWorkflows,
    workspacePath,
    automationOnly,
    includeBuiltinTemplates,
  ])
  return (
    <div data-testid="native-knowledge-content">
      {artifactFailure && <OperationError error={artifactFailure} />}
      {workflow?.owner === artifactOwner ? (
        <WorkflowExecutionCanvas
          serverId={serverId}
          workspacePath={workspacePath}
          threadId={workflow.threadId}
          reference={workflow.reference}
          active={isCurrent()}
          onClose={() => setWorkflow(undefined)}
        />
      ) : artifacts?.owner === artifactOwner ? (
        <TaskArtifactViewer
          target={{ serverId, workspacePath }}
          threadId={artifacts.threadId}
          references={artifacts.references}
          automationRunId={artifacts.runId}
          phase="completed"
          readExport={nativeOfficeReadExport}
          workflowTaskId={artifacts.workflowTaskId}
          onClose={() => setArtifacts(undefined)}
        />
      ) : (
        <>
          <KnowledgeIntegrationWorkspace
            automationOnly={automationOnly}
            automationView={automationView}
            creationWorkflow={creationWorkflow}
            workflowSchema={workflowSchema}
            workflowInputs={workflowInputs}
            onCreationBlocked={onCreationBlocked}
            onCreated={onCreated}
            renderSection={(activeSection, content) => (
              <KnowledgeFeatureSetup
                connection={client}
                key={activeSection}
                serverId={serverId}
                workspacePath={workspacePath}
                feature={
                  activeSection === 'memory'
                    ? 'memoryCenter'
                    : activeSection === 'knowledge'
                      ? 'sharedKnowledge'
                      : 'subscriptions'
                }
                isCurrent={isCurrent}
                onReconnect={onReconnect}
                onAvailable={activeSection === 'automation' ? markAutomationAvailable : undefined}
              >
                {() =>
                  activeSection !== 'automation' ? (
                    content()
                  ) : loaded?.key !== loadKey ? (
                    <p role="status">{t('loading')}</p>
                  ) : failure ? (
                    <div data-testid="native-template-failure">
                      <OperationError error={failure} />
                      <Button
                        variant="secondary"
                        data-testid="native-template-refresh"
                        onClick={() => setRevision(value => value + 1)}
                      >
                        {t('refresh')}
                      </Button>
                    </div>
                  ) : (
                    content()
                  )
                }
              </KnowledgeFeatureSetup>
            )}
            client={client}
            templates={templates}
            workflows={workflows}
            fileInputs={fileInputs}
            wikiInputs={wikiInputs}
            modelPolicyTarget={{ serverId, workspacePath }}
            embedded
            onSectionChange={next => {
              setAutomationAvailable(false)
              setSection(next)
            }}
            onOpenArtifacts={openArtifacts}
            onOpenNativeRun={openNativeRun}
            {...memoryTaskSnapshot}
          />
        </>
      )}
    </div>
  )
}
