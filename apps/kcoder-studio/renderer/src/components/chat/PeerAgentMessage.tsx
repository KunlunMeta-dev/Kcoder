import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUpRight, MessagesSquare } from 'lucide-react'
import { WorkbenchContext, WorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { resolveAgentMessageNavigation } from '@/kcoder/agentMessageNavigation'
import { captureAccountContextRevision } from '@/kcoder/accountContextEvents'
import { runtimeThreadId } from '@/lib/runtime-thread-id'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeTaskAddress } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'

/** Peer content stays plain text: it cannot mount widgets, questions or user-edit controls. */
export function PeerAgentMessage({ message, address }: { message: WorkbenchMessage; address?: RuntimeTaskAddress }) {
  const pane = useContext(WorkbenchPaneContext)
  const workbench = useContext(WorkbenchContext)
  const context = pane ?? workbench
  const mounted = useRef(true)
  const [opening, setOpening] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [address?.deviceId, address?.workspacePath, address?.threadId])
  const metadata = message.peerAgent
  const ownerKey = JSON.stringify([address?.deviceId, address?.workspacePath, address && runtimeThreadId(address), message.id])
  const owner = useRef(ownerKey)
  // Publish the committed owner before any click handler can read it.
  useLayoutEffect(() => { owner.current = ownerKey }, [ownerKey])
  const { t } = useTranslation('chat')
  const canOpen = metadata && address && runtimeThreadId(address) === metadata.targetThreadId
  const openSource = async () => {
    if (!canOpen || opening || !context || !address || !metadata) return
    const originalOwner = owner.current
    const accountCurrent = captureAccountContextRevision()
    setOpening(true); setFailed(false)
    try {
      const target = await resolveAgentMessageNavigation({ ...address }, metadata.sourceAddress, metadata.sourceThreadId)
      if (mounted.current && owner.current === originalOwner && accountCurrent(address.deviceId)) await context.openRuntimeTask(target)
    } catch { if (mounted.current && owner.current === originalOwner) setFailed(true) }
    finally { if (mounted.current && owner.current === originalOwner) setOpening(false) }
  }
  return <section data-testid="peer-agent-message" className="min-w-0 rounded-lg border border-border/60 bg-muted/30 px-4 py-3">
    <div className="mb-2 flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
      <MessagesSquare className="size-4 shrink-0" aria-hidden="true" />
      <span>{t('peerMessages.fromAgent')}</span>
      {canOpen ? <button type="button" className="inline-flex min-w-0 items-center gap-1 text-primary hover:underline"
        title={metadata.sourceThreadId} aria-label={t('peerMessages.openSource', { id: metadata.sourceThreadId })}
        disabled={opening} onClick={() => void openSource()}>
        <span className="truncate">{metadata.sourceThreadId}</span><ArrowUpRight className="size-3 shrink-0" aria-hidden="true" />
      </button> : <span>{metadata?.sourceThreadId ?? t('peerMessages.sourceUnknown')}</span>}
    </div>
    {failed && <p role="status" className="mb-2 text-sm text-muted-foreground">{t('peerMessages.navigationUnavailable')}</p>}
    <div className="whitespace-pre-wrap break-words text-chat text-foreground">{message.content}</div>
  </section>
}
