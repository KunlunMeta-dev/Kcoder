import { useContext, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useTranslation } from '@/hooks/useTranslation'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import { runtimeThreadId } from '@/lib/runtime-thread-id'
import { sameChannelTask, type ChannelChat } from '@/kcoder/channels'
import type { RuntimeTaskAddress } from '@/types/api'
import { channelChatTitle } from './channelPresentation'
import { TaskChannelBindingDialog } from './TaskChannelBindingDialog'

/** Choose an existing task, then reuse the ordinary chat binding confirmation and revision guard. */
export function ChannelRebindDialog({ chat, onClose, onChanged }: {
  chat: ChannelChat; onClose: () => void; onChanged: () => void
}) {
  const { t } = useTranslation('connectivity'), workbench = useContext(WorkbenchContext)
  const [selected, setSelected] = useState('')
  const [address, setAddress] = useState<RuntimeTaskAddress | null>(null)
  const work = workbench?.state?.runtimeWork
  const candidates = new Map<string, { address: RuntimeTaskAddress; label: string }>()
  for (const workspace of [...(work?.chats ?? []), ...(work?.projects.flatMap(project => project.deviceWorkspaces) ?? [])]) {
    if (!workspace.available) continue
    for (const task of workspace.tasks) {
      const address = { deviceId: workspace.deviceId, taskId: task.taskId, workspacePath: task.workspacePath,
        threadId: task.threadId, runtimeHandle: task.runtimeHandle }
      const threadId = runtimeThreadId(address)
      if (task.runtime !== 'kcoder' || task.optimistic || !threadId || !task.workspacePath || sameChannelTask(chat.binding?.target,
        { serverId: workspace.deviceId, workspacePath: task.workspacePath, threadId })) continue
      const key = JSON.stringify([workspace.deviceId, task.workspacePath, threadId])
      candidates.set(key, { address, label: `${workspace.deviceName || workspace.deviceId} › ${workspace.label || task.workspacePath} › ${task.title}` })
    }
  }
  if (address) return <TaskChannelBindingDialog address={address} onlyChatId={chat.id} onClose={onClose} taskLabel={candidates.get(selected)?.label}
    onBound={() => { onChanged(); onClose() }} />
  return <ModalDialog title={t('channelPresentation.rebind')} testId="channel-rebind-dialog" onClose={onClose} closeLabel={t('chatTasks.close')}>
    <div className="space-y-4 pt-3">
      <p className="font-medium">{channelChatTitle(chat, t)}</p>
      <p className="text-sm text-text-secondary">{t('channelPresentation.rebindHint')}</p>
      {!candidates.size ? <p role="status">{t('channelPresentation.noReplacementTasks')}</p> : <label className="block space-y-2">
        <span>{t('channelPresentation.replacementTask')}</span>
        <SettingsSelect value={selected} aria-label={t('channelPresentation.replacementTask')} onChange={event => setSelected(event.target.value)}>
          <option value="">{t('channelPresentation.selectReplacementTask')}</option>
          {[...candidates].map(([key, candidate]) => <option key={key} value={key}>{candidate.label}</option>)}
        </SettingsSelect>
      </label>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>{t('chatTasks.cancel')}</Button>
        <Button disabled={!candidates.has(selected)} onClick={() => setAddress(candidates.get(selected)!.address)}>{t('channelPresentation.reviewRebind')}</Button>
      </div>
    </div>
  </ModalDialog>
}
