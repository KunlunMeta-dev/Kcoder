import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { useSubagentConversation } from '@/features/subagents/useSubagentConversation'
import { SubagentWorkspace } from '@/features/subagents/SubagentWorkspace'
import { normalizeRuntimeSubagentStatus } from '@/components/layout/pane/subagentState'
import type { createRuntimeWorkApi } from '@/api/runtimeWork'
import type { BackgroundRunKey } from '../../../../../shared/generated/contracts'
import type { RuntimeTaskAddress } from '@/types/api'
import type { RuntimeSubagentSummary } from '@/types/subagents'
import type { SubagentArtifactPage } from '@/features/subagents/subagentWorkspaceState'
import { useTaskMemberControls } from './useTaskMemberControls'

type Api = Pick<
  ReturnType<typeof createRuntimeWorkApi>,
  'listRuntimeSubagents' | 'subscribeRuntimeSubagentConversation' | 'readSubagentArtifact'
> & Partial<Pick<ReturnType<typeof createRuntimeWorkApi>,
  'steerRuntimeSubagent' | 'readRuntimeSubagentCommand' | 'stopRuntimeSubagent'>>
export interface TaskMemberViewerProps {
  api?: Api
  address: RuntimeTaskAddress
  run: BackgroundRunKey
  parentLabel: string
  onClose: () => void
  onOpenParent?: (address: RuntimeTaskAddress) => void
}
function sameRun(value: unknown, run: BackgroundRunKey) {
  const actual = value as Partial<BackgroundRunKey> | undefined
  return (
    actual?.parentSessionId === run.parentSessionId &&
    actual?.agentId === run.agentId &&
    actual?.runId === run.runId
  )
}
/** Exact observer only; all execution stays in the normal authorized parent UI. */
export function TaskMemberViewer(props: TaskMemberViewerProps) {
  const scope = usePluginTargetScope(
    props.address.deviceId,
    props.address.workspacePath ?? undefined
  )
  const owner = JSON.stringify([
    scope.key,
    props.address.deviceId,
    props.address.taskId,
    props.address.threadId,
    props.address.workspacePath,
    props.run,
  ])
  return <MemberSession key={owner} {...props} isCurrent={scope.isCurrent} />
}
function MemberSession({
  api,
  address,
  run,
  parentLabel,
  onClose,
  onOpenParent,
  isCurrent,
}: TaskMemberViewerProps & { isCurrent: () => boolean }) {
  const { t } = useTranslation('taskMembers')
  const [summary, setSummary] = useState<RuntimeSubagentSummary>()
  const [controlScope, setControlScope] = useState<{ supported: boolean; continuation: boolean; journalScope: string }>()
  const [unavailable, setUnavailable] = useState(false)
  const [reload, setReload] = useState(0)
  const revisions = useRef(new Map<string, string>())
  const controls = useTaskMemberControls({ api, address, run, isCurrent,
    supported: controlScope?.supported === true,
    journalScope: controlScope?.journalScope })
  const conversation = useSubagentConversation(
    api,
    address,
    run.agentId,
    Boolean(summary) && !unavailable,
    {
      runId: run.runId,
      expectedBackgroundRun: run,
      ownerScope: JSON.stringify([
        address.deviceId,
        address.taskId,
        address.threadId,
        address.workspacePath,
        reload,
      ]),
    }
  )
  useEffect(() => {
    let active = true
    void Promise.resolve()
      .then(async () => {
        if (!api || address.threadId !== run.parentSessionId || !isCurrent())
          throw new Error('Exact member owner unavailable')
        const result = await api.listRuntimeSubagents({
          address: { ...address },
          agentId: run.agentId,
          expectedBackgroundRun: { ...run },
        })
        const actual = result.agents.find(
          member => member.agentId === run.agentId && sameRun(member.backgroundRun, run)
        )
        if (!active || !isCurrent()) return
        if (
          result.threadId !== run.parentSessionId ||
          result.capabilities.exactRun !== true ||
          result.capabilities.conversationStream !== true ||
          !actual
        )
          throw new Error('Exact member run unavailable')
        setSummary(actual)
        setControlScope({ supported: result.capabilities.exactControl === true
          && result.capabilities.receipts && result.capabilities.steering && result.capabilities.stop
          && Boolean(api.steerRuntimeSubagent && api.readRuntimeSubagentCommand && api.stopRuntimeSubagent),
          continuation: result.capabilities.exactContinuation === true,
          journalScope: result.journalScope })
      })
      .catch(() => {
        if (active && isCurrent()) setUnavailable(true)
      })
    return () => {
      active = false
    }
  }, [
    address,
    run,
    api,
    address.deviceId,
    address.taskId,
    address.threadId,
    address.workspacePath,
    run.parentSessionId,
    run.agentId,
    run.runId,
    isCurrent,
  ])
  const back = () => {
    onClose()
    if (isCurrent()) onOpenParent?.({ ...address })
  }
  const read = async (
    agent: string,
    kind: 'output' | 'transcript',
    offset: number
  ): Promise<SubagentArtifactPage> => {
    if (
      !api ||
      !isCurrent() ||
      agent !== run.agentId ||
      kind !== 'output' ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new Error(t('unavailable'))
    // The exact structured stream is the safe transcript. Never ask the legacy
    // per-agent checkpoint projection to stand in for this native run.
    const value = await api.readSubagentArtifact({
      address: { ...address },
      agentId: run.agentId,
      expectedBackgroundRun: { ...run },
      kind,
      offset,
      limit: 64 * 1024,
      ...(offset > 0 ? { revision: revisions.current.get(kind) } : {}),
    })
    if (
      !isCurrent() ||
      !sameRun(value.backgroundRun, run) ||
      typeof value.revision !== 'string' ||
      !value.revision ||
      value.offset !== offset ||
      !Number.isSafeInteger(value.size) ||
      (value.size ?? -1) < 0
    )
      throw new Error(t('unavailable'))
    revisions.current.set(kind, value.revision)
    return {
      content: value.content,
      truncated: value.truncated,
      offset: value.offset,
      nextOffset: value.nextOffset,
      revision: value.revision,
      size: value.size!,
    }
  }
  if (!summary || unavailable)
    return (
      <section className="space-y-4 p-6" data-testid="task-member-unavailable">
        <p role={unavailable ? 'alert' : 'status'} className="text-sm text-text-secondary">
          {t(unavailable ? 'unavailable' : 'loading')}
        </p>
        <Button variant="outline" onClick={back}>
          {t('back')}
        </Button>
      </section>
    )
  const continuation = controlScope?.continuation === true
    && ['completed', 'failed'].includes(conversation.status ?? summary.status)
  return (
    <SubagentWorkspace
      readOnly={!controls.ready}
      readOnlyMessages
      agent={{
        id: run.agentId,
        agentId: run.agentId,
        agentPath: run.agentId,
        agentName: summary.agentName || summary.presentation?.goal?.split('\n')[0] || run.agentId,
        status: normalizeRuntimeSubagentStatus(conversation.status ?? summary.status),
      }}
      parentLabel={parentLabel}
      runId={run.runId}
      role={summary.presentation?.role}
      goal={summary.presentation?.goal}
      directory={summary.presentation?.directory}
      connected={isCurrent() && !conversation.error}
      conversationMessages={conversation.messages ?? []}
      conversationActive={conversation.active}
      conversationLoading={conversation.loading}
      conversationError={conversation.error ? t('unavailable') : undefined}
      conversationKey={conversation.key}
      canSteer={controls.ready && (continuation || summary.acceptingMessages && conversation.active !== false)}
      instructionHint={continuation ? t('continueHint') : undefined}
      canStop={controls.ready && summary.presentation?.canStop === true
        && ['pending', 'running', 'paused'].includes(conversation.status ?? summary.status)}
      onStop={controls.onStop}
      onLookupCommand={controls.onLookupCommand}
      commandEpoch={controls.commandEpoch}
      commandHistory={controls.commandHistory}
      onCommandIntent={controls.onCommandIntent}
      onCommandUpdate={controls.onCommandUpdate}
      canArchiveCommands={false}
      canReadTranscript={false}
      onReadArtifact={read}
      onReadLatest={async (id, kind) => {
        if (conversation.error) {
          setReload(value => value + 1)
          throw new Error(t('unavailable'))
        }
        return read(id, kind, 0)
      }}
      onSteer={(id, message, clientId) => controls.onSteer(id, message, clientId, continuation)}
      onClose={back}
    />
  )
}
