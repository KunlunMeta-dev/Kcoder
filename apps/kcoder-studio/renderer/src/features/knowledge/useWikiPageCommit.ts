import { useEffect, useRef, useState } from 'react'
import { knowledgeApi, type WikiPage } from '@/kcoder/knowledgeApi'

type PageReceipt = { pageId: string; revisionId: string }

/** A committed write is followed only by reads, including after a failed refresh. */
export function useWikiPageCommit({
  serverId,
  libraryId,
  isCurrent,
  onCommitted,
  onClose,
}: {
  serverId: string
  libraryId: string
  isCurrent: () => boolean
  onCommitted: (page: WikiPage) => void
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<PageReceipt | null>(null)
  const [error, setError] = useState('')
  const revision = useRef(0)
  const inFlight = useRef(false)
  useEffect(() => {
    const lifetime = revision
    return () => {
      ++lifetime.current
    }
  }, [serverId, libraryId])
  const perform = async (write?: () => Promise<PageReceipt>) => {
    if (inFlight.current || (!write && !receipt) || (write && receipt)) return
    inFlight.current = true
    const attempt = ++revision.current
    const live = () => isCurrent() && attempt === revision.current
    setBusy(true)
    setError('')
    try {
      const committed = receipt ?? (await write!())
      if (!live()) return
      setReceipt(committed)
      const saved = await knowledgeApi.page(
        serverId,
        libraryId,
        committed.pageId,
        committed.revisionId
      )
      if (live()) {
        onCommitted(saved)
        onClose()
      }
    } catch (cause) {
      if (live()) setError(String(cause instanceof Error ? cause.message : cause))
    } finally {
      inFlight.current = false
      if (live()) setBusy(false)
    }
  }
  return { busy, receipt, error, commit: perform, reload: () => perform() }
}
