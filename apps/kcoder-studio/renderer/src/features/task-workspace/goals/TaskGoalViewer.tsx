import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { AssistantMarkdown } from '@/components/chat/AssistantMarkdown'
import { GoalStatusBar } from '@/components/chat/composer/GoalStatusBar'
import { ConversationWidgetsContext } from '@/components/chat/widgets/widgetContext'
import { useTranslation } from '@/hooks/useTranslation'
import { usePluginTargetScope } from '@/kcoder/usePluginTargetScope'
import { createTaskGoalObservation, TaskGoalObservationError, type TaskGoalReference, type ObservedTaskGoal } from '@/kcoder/taskGoalObservation'
import type { RuntimeTaskAddress } from '@/types/api'

export interface TaskGoalViewerProps {
  address: RuntimeTaskAddress
  reference: TaskGoalReference
  onClose: () => void
  onOpenParent?: () => void
}
export function TaskGoalViewer(props: TaskGoalViewerProps) {
  const scope = usePluginTargetScope(props.address.deviceId, props.address.workspacePath ?? undefined)
  return <GoalView key={JSON.stringify([scope.key, props.address, props.reference])} {...props} isCurrent={scope.isCurrent} />
}
function GoalView({ address, reference, onClose, onOpenParent, isCurrent }: TaskGoalViewerProps & { isCurrent: () => boolean }) {
  const { t, i18n } = useTranslation('taskGoal')
  const { t: task } = useTranslation('taskWorkspace')
  const { t: common } = useTranslation('common')
  const [goal, setGoal] = useState<ObservedTaskGoal>()
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(true), [refresh, setRefresh] = useState(0)
  const [supported, setSupported] = useState(true)
  const pending = useRef<AbortController | null>(null)
  const minimumRevision = useRef(reference.revision)
  useEffect(() => {
    let live = true
    const abort = new AbortController(); pending.current = abort
    let reader: ReturnType<typeof createTaskGoalObservation> | undefined
    void (async()=>{
      try { reader=createTaskGoalObservation(address,{...reference,revision:minimumRevision.current},isCurrent) }
      catch { throw new TaskGoalObservationError('unsupported') }
      return await reader.read(abort.signal)
    })().then(value => {
      if (live && isCurrent()) { minimumRevision.current=value.revision;setGoal(value) }
    }).catch(value => {
      if (live && isCurrent()) {
        setError(value)
        if(value instanceof TaskGoalObservationError && value.code==='unsupported')setSupported(false)
      }
    }).finally(() => { if (live && isCurrent()) setBusy(false) })
    return () => { live = false; abort.abort();reader?.dispose() }
  }, [address, reference, isCurrent, refresh])
  const code = error instanceof TaskGoalObservationError ? error.code : 'unavailable'
  return <section className="space-y-5 p-5" data-testid="task-goal-viewer">
    <div className="flex flex-wrap gap-2">
      <Button variant="ghost" className="min-h-11 md:min-h-0" onClick={onClose}>{task('back')}</Button>
      <Button variant="outline" className="min-h-11 md:min-h-0" disabled={busy || !supported} onClick={()=>{setBusy(true);setGoal(undefined);setError(undefined);setRefresh(value=>value+1)}} data-testid="task-goal-refresh">{task('refresh')}</Button>
      {busy && <Button variant="ghost" className="min-h-11 md:min-h-0" onClick={()=>{pending.current?.abort();setBusy(false);setGoal(undefined);setError(new TaskGoalObservationError('cancelled'))}}>{task('cancelRead')}</Button>}
      {onOpenParent && <Button variant="ghost" className="min-h-11 md:min-h-0" onClick={()=>{if(isCurrent())onOpenParent()}}>{common('workflowCanvas.openRunConversation')}</Button>}
    </div>
    <p className="text-sm text-text-secondary">{task('readOnly')}</p>
    {busy && <p role="status">{task('loading')}</p>}
    {error ? <p role="alert" className="text-sm text-text-secondary">{t(`errors.${code}`)}</p> : null}
    {goal && <>
      <GoalStatusBar goal={goal} readOnly />
      <ConversationWidgetsContext.Provider value={null}>
        <div className="studio-card-spacing workbench-card min-w-0"><AssistantMarkdown content={goal.objective.slice(0,16000)} /></div>
      </ConversationWidgetsContext.Provider>
      {goal.objective.length>16000 && <p className="text-sm text-text-secondary">{t('previewBound')}</p>}
      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
        <div><dt className="text-text-secondary">{t('recordedTokens')}</dt><dd className="mt-1 text-text-primary">{goal.tokensUsed.toLocaleString(i18n.language)}</dd></div>
        <div><dt className="text-text-secondary">{t('recordedBudget')}</dt><dd className="mt-1 text-text-primary">{goal.tokenBudget===null?t('noBudget'):goal.tokenBudget.toLocaleString(i18n.language)}</dd></div>
        <div><dt className="text-text-secondary">{t('recordedTime')}</dt><dd className="mt-1 text-text-primary">{goal.timeUsedSeconds.toLocaleString(i18n.language)} {t('seconds')}</dd></div>
      </dl>
      <section className="space-y-3" aria-label={t('recentEvents')}>
        <h2 className="text-lg font-medium">{t('recentEvents')}</h2><p className="text-sm text-text-secondary">{t('eventBound')}</p>
        {goal.events ? goal.events.length ? <ol className="divide-y divide-border">{goal.events.map((event,index)=><li key={`${event.timestamp}:${index}`} className="space-y-1 py-3"><p className="whitespace-pre-wrap break-words text-sm">{event.summary}</p><p className="text-xs text-text-secondary">{new Date(event.timestamp).toLocaleString(i18n.language)} · {event.kind}</p></li>)}</ol> : <p className="text-sm text-text-secondary">{task('knownNone')}</p> : <p className="text-sm text-text-secondary">{task('unknown')}</p>}
      </section>
      <details className="text-xs text-text-secondary"><summary>{task('reference')}</summary><p className="mt-2 break-all">{goal.threadId} · {goal.goalId} · r{goal.revision}</p></details>
    </>}
  </section>
}
