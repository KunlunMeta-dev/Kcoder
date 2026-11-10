import { useEffect } from 'react'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { subscribeToAppshots } from '@/host/appshots'

interface AppshotBridgeProps {
  onOpenStudio: () => void
}

export function AppshotBridge({ onOpenStudio }: AppshotBridgeProps) {
  const { addExistingAttachment } = useWorkbench().projectChat

  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined

    subscribeToAppshots(attachments => {
      if (!active) return
      onOpenStudio()
      attachments.forEach(attachment => addExistingAttachment(attachment))
    })
      .then(dispose => {
        if (active) {
          unlisten = dispose
        } else {
          dispose()
        }
      })
      .catch(error => {
        console.error('[KCoder Studio] Failed to initialize Appshots:', error)
      })

    return () => {
      active = false
      unlisten?.()
    }
  }, [addExistingAttachment, onOpenStudio])

  return null
}
