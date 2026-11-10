import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { PageContent } from '@/components/ui/page-content'
import { useTranslation } from '@/hooks/useTranslation'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { findRuntimeTask } from '@/features/workbench/workbenchRuntimeHelpers'
import { KnowledgeIntegrationClient } from '@/features/knowledge-integration/client'
import { MemoryCenter } from '@/features/knowledge-integration/MemoryCenter'
import { KnowledgeFeatureSetup } from '@/features/runtime-governance/KnowledgeFeatureSetup'
import { nativeKnowledgeTransport } from '@/features/runtime-governance/knowledgeTransport'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { requestLocalExecutor } from '@/host/localExecutor'
import { isIntegrationScope } from '../../../../shared/generated/contractGuards.mjs'

/** Wiki presentation shares its selected target without copying or migrating domain storage. */
export function WikiManagedKnowledge({
  serverId,
  workspacePath,
  section,
}: {
  serverId: string
  workspacePath?: string
  section: 'memory'
}) {
  const { t } = useTranslation('knowledgeIntegration')
  const { state } = useWorkbench()
  const scope = usePluginTargetScope(serverId, workspacePath)
  const { key, isCurrent } = scope
  const [revision, setRevision] = useState(0)
  const [ready, setReady] = useState<{ key: string; client: KnowledgeIntegrationClient }>()
  const [failure, setFailure] = useState<string>()
  useEffect(() => {
    const cancel = new AbortController()
    let owned: KnowledgeIntegrationClient | undefined
    void requestLocalExecutor<unknown>(
      'runtime.integrations.request',
      {
        serverId,
        workspacePath,
        method: 'integrations/scope/read',
        params: {},
      },
      { signal: cancel.signal }
    )
      .then(nativeScope => {
        if (cancel.signal.aborted || !isCurrent()) return
        if (!isIntegrationScope(nativeScope)) throw new Error('INTEGRATION_SCOPE_UNAVAILABLE')
        owned = new KnowledgeIntegrationClient(
          nativeScope,
          nativeKnowledgeTransport({ serverId, workspacePath })
        )
        setFailure(undefined)
        setReady({ key, client: owned })
      })
      .catch(() => {
        if (!cancel.signal.aborted && isCurrent()) setFailure(key)
      })
    return () => {
      cancel.abort()
      owned?.dispose()
    }
  }, [serverId, workspacePath, key, isCurrent, revision])
  const client = ready?.key === key && isCurrent() ? ready.client : undefined
  const reconnect = () => {
    setReady(undefined)
    setFailure(undefined)
    setRevision(value => value + 1)
  }
  const task = findRuntimeTask(state.runtimeWork, state.currentRuntimeTask)
  const locator = task?.runtimeHandle?.memoryTaskSnapshot as
    { threadId?: unknown; snapshotId?: unknown } | undefined
  const snapshot =
    state.currentRuntimeTask?.deviceId === serverId &&
    state.currentRuntimeTask.workspacePath === workspacePath &&
    typeof locator?.snapshotId === 'string' &&
    locator.snapshotId.length > 0 &&
    typeof locator.threadId === 'string' &&
    locator.threadId === task?.threadId
      ? { taskId: locator.snapshotId, threadId: locator.threadId }
      : undefined
  return (
    <div
      className="studio-page-gutter min-h-0 flex-1 overflow-y-auto py-5"
      data-testid="wiki-managed-knowledge"
    >
      {!client ? (
        <PageContent className="space-y-3" role={failure === key ? 'alert' : 'status'}>
          <p>{t(failure === key ? 'nativeUnavailable' : 'loading')}</p>
          {failure === key && (
            <Button variant="outline" onClick={reconnect}>
              {t('refresh')}
            </Button>
          )}
        </PageContent>
      ) : (
        <PageContent>
          <KnowledgeFeatureSetup
            key={`${client.ownerKey}:${section}`}
            serverId={serverId}
            workspacePath={workspacePath}
            feature="memoryCenter"
            isCurrent={isCurrent}
            onReconnect={reconnect}
          >
            {() => <MemoryCenter key={client.ownerKey} client={client} {...snapshot} />}
          </KnowledgeFeatureSetup>
        </PageContent>
      )}
    </div>
  )
}
