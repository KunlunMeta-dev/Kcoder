import { useEffect, useState } from 'react'
import { desktopHost, readDesktopTrayAvailability, type DesktopTrayAvailability } from './desktopHost'

export function useDesktopTrayAvailability(): DesktopTrayAvailability {
  const host = desktopHost()
  const [observed, setObserved] = useState<{ host: typeof host; value: DesktopTrayAvailability }>()
  useEffect(() => {
    if (!host) return
    let disposed = false
    let revision = 0
    const refresh = () => {
      const current = ++revision
      setObserved({ host, value: 'unknown' })
      void readDesktopTrayAvailability(host).then(value => {
        if (!disposed && current === revision && host === desktopHost()) setObserved({ host, value })
      })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => { disposed = true; window.removeEventListener('focus', refresh) }
  }, [host])
  return observed && observed.host === host ? observed.value : 'unknown'
}
