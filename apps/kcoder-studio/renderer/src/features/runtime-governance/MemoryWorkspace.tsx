import { WorkspacePageHeader } from '@/components/layout/WorkspacePageHeader'
import { currentHostDeviceId } from '@/features/runtime-target/currentHostTarget'
import { PageContent } from '@/components/ui/page-content'
import { KnowledgeFeatureSetup } from './KnowledgeFeatureSetup'
import { useEffect, useState } from 'react'
import { Brain } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { workbenchModelTarget } from '@/features/workbench/workbenchModelTarget'
import { findRuntimeTask } from '@/features/workbench/workbenchRuntimeHelpers'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { requestLocalExecutor } from '@/host/localExecutor'
import { isIntegrationScope } from '../../../../shared/generated/contractGuards.mjs'
import { KnowledgeIntegrationClient } from '@/features/knowledge-integration/client'
import { MemoryCenter } from '@/features/knowledge-integration/MemoryCenter'
import { useTranslation } from '@/hooks/useTranslation'
import { nativeMemoryTransport } from './memoryTransport'

export function MemoryWorkspace({ includeKnowledge = false }: { includeKnowledge?: boolean }) {
  const { t } = useTranslation('knowledgeIntegration')
  const { state } = useWorkbench()
  const target = workbenchModelTarget(state)
  const [requested, setRequested] = useState<string | null>(null)
  const serverId = state.devices.some(device => device.device_id === requested)
    ? requested!
    : (currentHostDeviceId(state.devices) ?? '')
  const workspacePath = serverId === target.deviceId ? target.workspacePath : undefined
  const scope = usePluginTargetScope(serverId, workspacePath)
  const { key: scopeKey, isCurrent } = scope
  const [revision, setRevision] = useState(0)
  const [ready, setReady] = useState<{ key: string; client: KnowledgeIntegrationClient } | null>(
    null
  )
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    let owned: KnowledgeIntegrationClient | undefined
    if (serverId) {
      void requestLocalExecutor<unknown>(
        'runtime.integrations.request',
        { serverId, workspacePath, method: 'integrations/scope/read', params: {} },
        { signal: controller.signal }
      )
        .then(nativeScope => {
          if (controller.signal.aborted || !isCurrent()) return
          if (!isIntegrationScope(nativeScope)) throw new Error('INTEGRATION_SCOPE_UNAVAILABLE')
          const transport = nativeMemoryTransport
          owned = new KnowledgeIntegrationClient(
            nativeScope,
            transport({ serverId, workspacePath })
          )
          setFailure(null)
          setReady({ key: scopeKey, client: owned })
        })
        .catch(() => {
          if (!controller.signal.aborted && isCurrent()) setFailure(scopeKey)
        })
    }
    return () => {
      controller.abort()
      owned?.dispose()
    }
  }, [serverId, workspacePath, scopeKey, isCurrent, revision, includeKnowledge])
  const reconnect = () => {
    setReady(null)
    setRevision(value => value + 1)
  }
  const client = ready?.key === scope.key ? ready.client : null
  const task = findRuntimeTask(state.runtimeWork, state.currentRuntimeTask)
  const locator = task?.runtimeHandle?.memoryTaskSnapshot as
    | {
        threadId?: unknown
        snapshotId?: unknown
      }
    | undefined
  const selectedSnapshot =
    state.currentRuntimeTask?.deviceId === serverId &&
    state.currentRuntimeTask.workspacePath === workspacePath &&
    typeof locator?.snapshotId === 'string' &&
    locator.snapshotId.length > 0 &&
    typeof locator.threadId === 'string' &&
    locator.threadId === task?.threadId
      ? { taskId: locator.snapshotId, threadId: locator.threadId }
      : undefined
  return (
    <main
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface/40 text-text-primary"
      data-testid="memory-workspace"
    >
      <WorkspacePageHeader
        title={t(includeKnowledge ? 'title' : 'memory')}
        backLabel={t('back')}
        actions={
          <>
            {' '}
            <SettingsSelect
              density="compact"
              icon={<Brain />}
              value={serverId}
              aria-label={t('targetLabel')}
              onChange={event => setRequested(event.target.value)}
            >
              <option value="">{t('targetLabel')}</option>
              {state.devices.map(device => (
                <option key={device.device_id} value={device.device_id}>
                  {device.name}
                </option>
              ))}
            </SettingsSelect>{' '}
          </>
        }
      />
      <div className="studio-page-gutter min-h-0 flex-1 overflow-y-auto py-5">
        {!serverId ? (
          <p className="p-5 text-text-secondary">{t('targetLabel')}</p>
        ) : failure === scope.key ? (
          <div role="alert" className="space-y-3 p-5">
            <p>{t('nativeUnavailable')}</p>
            <Button
              variant="secondary"
              onClick={() => {
                setFailure(null)
                setReady(null)
                setRevision(value => value + 1)
              }}
            >
              {t('refresh')}
            </Button>
          </div>
        ) : client ? (
          <PageContent>
            <KnowledgeFeatureSetup
              serverId={serverId}
              workspacePath={workspacePath}
              feature="memoryCenter"
              isCurrent={isCurrent}
              onReconnect={reconnect}
            >
              {() => <MemoryCenter key={client.ownerKey} client={client} {...selectedSnapshot} />}
            </KnowledgeFeatureSetup>
          </PageContent>
        ) : (
          <p role="status" className="p-5 text-text-muted">
            {t('loading')}
          </p>
        )}
      </div>
    </main>
  )
}
