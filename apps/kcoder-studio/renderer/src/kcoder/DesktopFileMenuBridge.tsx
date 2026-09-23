import { useEffect } from 'react'
import { useAuth } from '@/features/auth/useAuth'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { navigateTo } from '@/lib/navigation'
import { desktopHost } from './desktopHost'
import { clearPendingDesktopFileActions, requestDesktopFileAction } from './desktopFileActions'

export function DesktopFileMenuBridge() {
  const { startNewChat } = useWorkbench()
  const { logout } = useAuth()
  useEffect(() => {
    const unsubscribe = desktopHost()?.onMenuCommand?.(command => {
      if (command === 'logout') {
        clearPendingDesktopFileActions()
        logout()
      } else if (command === 'new-chat') {
        startNewChat()
        navigateTo('/')
      } else if (command === 'new-temporary-chat' || command === 'open-folder') {
        navigateTo('/')
        requestDesktopFileAction(command)
      }
    })
    return () => {
      unsubscribe?.()
      clearPendingDesktopFileActions()
    }
  }, [logout, startNewChat])
  return null
}
