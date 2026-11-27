import { useEffect, useMemo, useState } from 'react'

/** How long a transient composer notice stays fully visible. */
export const TRANSIENT_NOTICE_VISIBLE_MS = 5000
/** Duration of the fade before the notice is removed. */
export const TRANSIENT_NOTICE_FADE_MS = 300

/**
 * Fade a transient notice after a delay, then ask the owner to clear it.
 *
 * `notice` is the owner's current value (null when hidden); each new value
 * restarts the timer. While `held` (pointer over the notice, focus inside it)
 * the notice stays fully visible and the timer restarts when released. Returns
 * whether the current notice is fading so the caller can animate opacity
 * without changing layout.
 */
export function useTransientNotice<T>(notice: T | null, clear: (notice: T) => void, held = false) {
  const display = useMemo(() => ({ notice, held, clear }), [notice, held, clear])
  const [fading, setFading] = useState<typeof display | null>(null)
  useEffect(() => {
    const { notice, held, clear } = display
    if (notice === null || held) return
    const fade = window.setTimeout(() => setFading(display), TRANSIENT_NOTICE_VISIBLE_MS)
    const remove = window.setTimeout(
      () => clear(notice),
      TRANSIENT_NOTICE_VISIBLE_MS + TRANSIENT_NOTICE_FADE_MS
    )
    return () => {
      window.clearTimeout(fade)
      window.clearTimeout(remove)
    }
  }, [display])
  return fading === display
}
