import { useSidebarWindowFocus } from '@/components/layout/sidebar/useSidebarWindowFocus'
import { useEffect, type ReactNode } from 'react'
import { desktopHost } from '@/kcoder/desktopHost'
import { RuntimeTaskLifecycleContext } from './internalContext'
import type { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

export function RuntimeTaskLifecycleProvider({
  store,
  children,
}: {
  store: RuntimeTaskLifecycleStore
  children: ReactNode
}) {
  const host = desktopHost()
  const focused = useSidebarWindowFocus()
  useEffect(() => {
    const update = () => store.setWindowFocused(focused && document.visibilityState !== 'hidden')
    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [store, focused])
  useEffect(() => {
    if (!host) return
    const publish = async (count: number | null) => host.setTaskActivity(count)
    let submitted: { count: number } | null = null
    const synchronize = () => {
      const count = store.getSnapshot().runningTaskKeys.size
      if (submitted?.count === count) return
      const publication = { count }
      submitted = publication
      void publish(count).catch(error => {
        if (submitted === publication) submitted = null
        console.error('Failed to synchronize desktop task activity', error)
      })
    }
    synchronize()
    const unsubscribe = store.subscribe(synchronize)
    return () => {
      unsubscribe()
      void publish(null).catch(() => {})
    }
  }, [store, host])

  return (
    <RuntimeTaskLifecycleContext.Provider value={store}>
      {children}
    </RuntimeTaskLifecycleContext.Provider>
  )
}
