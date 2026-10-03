import { useEffect, useRef, useState } from 'react'
import { Boxes } from 'lucide-react'
import { useOptionalAppearance } from '@/features/appearance'
import { resolvePluginAssetUrl } from './plugin-assets'

export type PluginIconLoader = (id: string, dark: boolean) => Promise<string | null>
export function PluginIcon({
  id,
  source,
  darkSource,
  loader,
  revision,
  preferSource = false,
  className = 'h-full w-full',
}: {
  id: string | number
  source?: string | null
  darkSource?: string | null
  loader?: PluginIconLoader
  revision?: string
  preferSource?: boolean
  className?: string
}) {
  const appearance = useOptionalAppearance()
  const dark = appearance?.resolvedMode === 'dark'
  const host = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined')
  const [loaded, setLoaded] = useState<{
    key: string
    url: string | null
    loader: PluginIconLoader
    lightFallback: boolean
  } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [networkRevision, setNetworkRevision] = useState(0)
  useEffect(() => {
    const refresh = () => setNetworkRevision(value => value + 1)
    window.addEventListener('kcoder:plugin-icons-invalidated', refresh)
    return () => window.removeEventListener('kcoder:plugin-icons-invalidated', refresh)
  }, [])
  const key = `${id}:${dark}:${revision ?? ''}:${networkRevision}`
  useEffect(() => {
    if (!host.current) return
    if (typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '120px' }
    )
    observer.observe(host.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    let active = true
    if (visible && loader && !preferSource) {
      void Promise.all([
        loader(String(id), dark),
        dark ? loader(String(id), false) : Promise.resolve(null),
      ])
        .catch(() => [null, null])
        .then(([url, light]) => {
          if (active) setLoaded({ key, url, loader, lightFallback: dark && url === light })
        })
    }
    return () => {
      active = false
    }
  }, [visible, loader, id, dark, key, source, darkSource, preferSource])
  const fallback = resolvePluginAssetUrl((dark && darkSource) || source)
  const url = (loaded?.key === key && loaded.loader === loader ? loaded.url : null) || fallback
  const lightBackdrop = dark && (loaded?.key === key ? loaded.lightFallback : !darkSource)
  return (
    <span
      ref={host}
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg ${lightBackdrop && url && failed !== url ? 'bg-white' : ''} ${className}`}
      aria-hidden="true"
    >
      {url && failed !== url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="h-full w-full object-contain"
          onError={() => setFailed(url)}
        />
      ) : (
        <Boxes className="h-5 w-5" />
      )}
    </span>
  )
}
