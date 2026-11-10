import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRandomUuid } from '@/lib/random-id'
import type { RuntimeTaskAddress } from '@/types/api'
import { attachTaskView, releaseTaskView } from './taskLifetime'
import { listenAccountContextChanges } from './accountContextEvents'

/** Visible panes own views; cached pages and background history reads do not. */
export function useTaskViewAttachment(address: RuntimeTaskAddress | null, visible: boolean) {
  const latest = useRef(address)
  useLayoutEffect(() => { latest.current = address }, [address])
  const [accountRevision, setAccountRevision] = useState(0)
  useEffect(() => listenAccountContextChanges(targetId => {
    if (latest.current?.deviceId === targetId) setAccountRevision(value => value + 1)
  }), [])
  // The runtime resolves the task's authoritative thread/workspace. Metadata
  // hydration must not retire a still-visible conversation's attachment.
  const key = address ? JSON.stringify([address.deviceId, address.taskId]) : null
  useEffect(() => {
    const original = latest.current
    if (!visible || !original) return
    const viewId = createRandomUuid()
    void attachTaskView(original, viewId).catch(error => {
      console.warn('[KCoder Studio] Conversation attachment unavailable', error)
    })
    return () => {
      void releaseTaskView(original, viewId).catch(error => {
        console.warn('[KCoder Studio] Conversation detach unconfirmed', error)
      })
    }
  }, [key, visible, accountRevision])
}
