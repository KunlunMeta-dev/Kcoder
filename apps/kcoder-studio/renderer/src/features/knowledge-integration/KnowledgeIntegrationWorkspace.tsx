import { PAGE_CONTENT_COLUMN_MAX_WIDTH_CLASS } from '@/components/ui/page-content'
import { navigateTo } from '@/lib/navigation'
import type { AutomationTemplate } from '../../../../shared/generated/contracts'
import { useState, type ReactNode } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import type { KnowledgeIntegrationClient } from './client'
import { MemoryCenter } from './MemoryCenter'
import {
  type PublishableWikiPage,
  type PublishableAudience,
} from './KnowledgePublications'
import { BusinessSubscriptions, type SavedBusinessWorkflow } from './BusinessSubscriptions'
import type { SavedBusinessInputResource } from './BusinessTemplateInputs'
import type { NativeWikiPublicationInputs } from './wikiPublicationInputs'
import type { NativeAutomationFileInputs } from './automationFileInputs'
import type { ModelPolicyTarget } from '@/kcoder/modelPolicies'
export function KnowledgeIntegrationWorkspace({
  client,
  workflows,
  templates,
  sourceResources,
  taskId,
  threadId,
  onOpenNativeTask,
  onOpenNativeRun,
  onOpenArtifacts,
  embedded = false,
  onSectionChange,
  fileInputs,
  modelPolicyTarget,
  renderSection,
  automationOnly = false,
  automationView = 'all',
  creationWorkflow,
  workflowSchema,
  workflowInputs,
  onCreationBlocked,
  onCreated,
}: {
  automationOnly?: boolean
  automationView?: 'all' | 'create' | 'manage' | 'inbox'
  creationWorkflow?: SavedBusinessWorkflow
  workflowSchema?: unknown
  workflowInputs?: string
  onCreated?: () => void
  onCreationBlocked?: (blocked: boolean) => void
  renderSection?: (
    section: 'memory' | 'knowledge' | 'automation',
    content: () => ReactNode
  ) => ReactNode
  client: KnowledgeIntegrationClient
  sourcePages?: PublishableWikiPage[]
  audiences?: PublishableAudience[]
  workflows?: SavedBusinessWorkflow[]
  templates?: AutomationTemplate[]
  sourceResources?: SavedBusinessInputResource[]
  taskId?: string
  threadId?: string
  onOpenNativeTask?: (threadId: string) => void
  onOpenNativeRun?: (runId: string) => void
  onOpenArtifacts?: (runId: string) => void
  embedded?: boolean
  onSectionChange?: (section: 'memory' | 'knowledge' | 'automation') => void
  wikiInputs?: NativeWikiPublicationInputs
  fileInputs?: NativeAutomationFileInputs
  modelPolicyTarget?: ModelPolicyTarget
}) {
  const { t } = useTranslation('knowledgeIntegration')
  const [advancedSubscriptionsOpen, setAdvancedSubscriptionsOpen] = useState(false)
  const [section, setSection] = useState<'memory' | 'automation'>(
    automationOnly ? 'automation' : 'memory'
  )
  const content = () =>
    section === 'memory' ? (
      <MemoryCenter client={client} taskId={taskId} threadId={threadId} />
    ) : (
      <BusinessSubscriptions
        view={automationView}
        creationWorkflow={creationWorkflow}
        workflowSchema={workflowSchema}
        workflowInputs={workflowInputs}
        onCreationBlocked={onCreationBlocked}
        onCreated={onCreated}
        client={client}
        workflows={workflows}
        templates={templates}
        sourceResources={sourceResources}
        fileInputs={fileInputs}
        modelPolicyTarget={modelPolicyTarget}
        onOpenNativeTask={onOpenNativeTask}
        onOpenNativeRun={onOpenNativeRun}
        onOpenArtifacts={onOpenArtifacts}
      />
    )
  return (
    <section
      className={embedded
        ? 'min-w-0 w-full space-y-5 text-text-primary'
        : `mx-auto min-w-0 w-full ${PAGE_CONTENT_COLUMN_MAX_WIDTH_CLASS} space-y-5 p-5 text-text-primary`}
      data-testid="knowledge-integration-workspace"
    >
      {!embedded && <h1 className="heading-base font-semibold">{t('title')}</h1>}
      {!automationOnly && (
        <nav
          aria-label={t('title')}
          className="flex w-fit max-w-full flex-wrap gap-1 rounded-xl border border-text-primary/5 bg-text-primary/5 p-1"
        >
          {(['memory'] as const).map(key => (
            <Button
              key={key}
              variant={section === key ? 'outline' : 'ghost'}
              aria-current={section === key ? 'page' : undefined}
              onClick={() => {
                setAdvancedSubscriptionsOpen(false)
                setSection(key)
                onSectionChange?.(key)
              }}
              data-testid={`knowledge-section-${key}`}
            >
              {t(key)}
            </Button>
          ))}
        </nav>
      )}
      <div key={`${client.ownerKey}-${section}`}>
        {automationOnly ? (
          renderSection ? (
            renderSection('automation', content)
          ) : (
            content()
          )
        ) : section === 'automation' ? (
          <>
            <section
              className="studio-card-spacing workbench-card space-y-3"
              data-testid="simple-scheduled-task-entry"
            >
              <h2 className="font-medium">{t('schedulePlainTask')}</h2>
              <p className="text-sm text-text-secondary">{t('schedulePlainTaskHint')}</p>
              <Button onClick={() => navigateTo('/automations')} data-testid="schedule-plain-task">
                {t('schedulePlainTask')}
              </Button>
            </section>
            <Button
              variant="ghost"
              aria-expanded={advancedSubscriptionsOpen}
              onClick={() => setAdvancedSubscriptionsOpen(value => !value)}
              data-testid="advanced-material-subscriptions"
            >
              {t('advancedMaterialSubscriptions')}
            </Button>
            {advancedSubscriptionsOpen &&
              (renderSection ? renderSection(section, content) : content())}
          </>
        ) : renderSection ? (
          renderSection(section, content)
        ) : (
          content()
        )}
      </div>
    </section>
  )
}
