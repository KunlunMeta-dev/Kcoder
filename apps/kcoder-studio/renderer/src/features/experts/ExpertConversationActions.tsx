import { useState } from 'react'
import { Copy, Pencil, Pin } from 'lucide-react'
import { ActionMenu } from '@/components/common/ActionMenu'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { Button } from '@/components/ui/button'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import { toBrowserPath } from '@/lib/navigation'
import type { RuntimeTaskAddress } from '@/types/api'

export function ExpertConversationActions({
  address,
  title,
  pinned,
  route,
}: {
  address: RuntimeTaskAddress
  title: string
  pinned: boolean
  route: string
}) {
  const { t } = useTranslation('experts')
  const { renameRuntimeTask, setRuntimeTaskPinned } = useWorkbench()
  const [editing, setEditing] = useState(false)
  const [nextTitle, setNextTitle] = useState(title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  return (
    <>
      <ActionMenu
        ariaLabel={t('more')}
        testId={`expert-conversation-menu-${address.taskId}`}
        placement="bottom-end"
        triggerClassName="h-6 w-6 text-text-muted"
        disabled={busy}
        items={[
          {
            label: t('conversation.rename'),
            icon: Pencil,
            testId: 'expert-conversation-rename',
            onSelect: () => {
              setNextTitle(title)
              setError(false)
              setEditing(true)
            },
          },
          {
            label: t(pinned ? 'conversation.unpin' : 'conversation.pin'),
            icon: Pin,
            testId: 'expert-conversation-pin',
            disabled: !address.threadId,
            onSelect: async () => {
              if (!address.threadId) return
              setBusy(true)
              setError(false)
              try {
                await setRuntimeTaskPinned({
                  deviceId: address.deviceId,
                  threadId: address.threadId,
                  pinned: !pinned,
                })
              } catch {
                setError(true)
              } finally {
                setBusy(false)
              }
            },
          },
          {
            label: t('conversation.copyLink'),
            icon: Copy,
            testId: 'expert-conversation-copy-link',
            onSelect: async () => {
              setError(false)
              try {
                await navigator.clipboard.writeText(
                  new URL(toBrowserPath(route), window.location.origin).href
                )
              } catch {
                setError(true)
              }
            },
          },
        ]}
      />
      {error && !editing && (
        <span role="alert" className="text-xs">
          {t('conversation.actionFailed')}
        </span>
      )}
      {editing && (
        <ModalDialog
          title={t('conversation.rename')}
          testId="expert-conversation-rename-dialog"
          onClose={() => {
            if (!busy) setEditing(false)
          }}
          closeLabel={t('close')}
        >
          <form
            className="mt-4 space-y-4"
            onSubmit={async event => {
              event.preventDefault()
              if (!nextTitle.trim() || busy) return
              setBusy(true)
              setError(false)
              try {
                await renameRuntimeTask(address, nextTitle.trim())
                setEditing(false)
              } catch {
                setError(true)
              } finally {
                setBusy(false)
              }
            }}
          >
            <input
              className="w-full rounded-lg border border-border bg-background p-2"
              aria-label={t('name')}
              value={nextTitle}
              maxLength={200}
              disabled={busy}
              onChange={event => setNextTitle(event.target.value)}
            />
            {error && <p role="alert">{t('conversation.actionFailed')}</p>}
            <Button type="submit" disabled={busy || !nextTitle.trim()}>
              {t('save')}
            </Button>
          </form>
        </ModalDialog>
      )}
    </>
  )
}
