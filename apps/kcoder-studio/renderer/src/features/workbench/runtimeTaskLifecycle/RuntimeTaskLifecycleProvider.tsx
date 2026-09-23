import { useEffect, type ReactNode } from 'react'
import { syncDesktopTaskActivity } from '@/kcoder/desktopHost'
import { RuntimeTaskLifecycleContext } from './internalContext'
import type { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

export function RuntimeTaskLifecycleProvider({
  store,
  children,
}: {
  store: RuntimeTaskLifecycleStore
  children: ReactNode
}) {
  useEffect(() => {
    const synchronize = () => {
      void syncDesktopTaskActivity(store.getSnapshot().runningTaskKeys.size).catch(error => {
        console.error('Failed to synchronize desktop task activity', error)
      })
    }
    synchronize()
    const unsubscribe = store.subscribe(synchronize)
    return () => {
      unsubscribe()
      void syncDesktopTaskActivity(null).catch(() => {})
    }
  }, [store])

  return (
    <RuntimeTaskLifecycleContext.Provider value={store}>
      {children}
    </RuntimeTaskLifecycleContext.Provider>
  )
}
