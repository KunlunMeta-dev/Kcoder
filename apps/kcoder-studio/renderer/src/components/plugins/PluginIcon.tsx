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
    primary: string | null
    light: string | null
    loader: PluginIconLoader
  } | null>(null)
  const [failed, setFailed] = useState<{
    key: string
    loader: PluginIconLoader | undefined
    urls: string[]
  } | null>(null)
  const [networkRevision, setNetworkRevision] = useState(0)
  useEffect(() => {
    const refresh = () => setNetworkRevision(value => value + 1)
    window.addEventListener('kcoder:plugin-icons-invalidated', refresh)
    return () => window.removeEventListener('kcoder:plugin-icons-invalidated', refresh)
  }, [])
  const key = `${id}:${dark}:${revision ?? ''}:${networkRevision}`
  useEffect(() => {
    if (!host.current || typeof IntersectionObserver === 'undefined') return
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
      const read = (theme: boolean, field: 'primary' | 'light') => {
        // Publish each result independently so a slow optional read cannot
        // delay a ready icon or discard it when the other theme fails.
        void Promise.resolve()
          .then(() => loader(String(id), theme))
          .catch(() => null)
          .then(url => {
            if (!active) return
            setLoaded(previous => ({
              ...(previous?.key === key && previous.loader === loader
                ? previous
                : { key, loader, primary: null, light: null }),
              [field]: url,
            }))
          })
      }
      read(dark, 'primary')
      if (dark) read(false, 'light')
    }
    return () => {
      active = false
    }
  }, [visible, loader, id, dark, key, source, darkSource, preferSource])
  const current = loaded?.key === key && loaded.loader === loader ? loaded : null
  const lightSource = resolvePluginAssetUrl(source)
  const darkAsset = dark ? resolvePluginAssetUrl(darkSource) : ''
  const failedUrls = failed?.key === key && failed.loader === loader ? failed.urls : []
  const url = [current?.primary, current?.light, darkAsset, lightSource].find(
    candidate => candidate && !failedUrls.includes(candidate)
  )
  const lightBackdrop = dark && url && (url === current?.light || url === lightSource)
  return (
    <span
      ref={host}
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg ${lightBackdrop ? 'bg-white' : ''} ${className}`}
      aria-hidden="true"
    >
      {url ? (
        <img
          key={`${key}:${url}`}
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="h-full w-full object-contain"
          onError={() =>
            setFailed(previous => ({
              key,
              loader,
              urls:
                previous?.key === key && previous.loader === loader
                  ? [...new Set([...previous.urls, url])]
                  : [url],
            }))
          }
        />
      ) : (
        <Boxes className="h-5 w-5" />
      )}
    </span>
  )
}
