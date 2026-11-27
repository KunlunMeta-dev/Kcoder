import { useCallback, useEffect, useState } from 'react'
import { LOCAL_PLUGIN_SKILLS_CHANGED_EVENT } from '@/features/plugins/pluginTrial'

type Source<T> = () => Promise<T[]>
const EMPTY: never[] = []

/** Menu-owned metadata only. A changed source cannot publish into a replacement target. */
export function useComposerDirectory<T>(source: Source<T> | undefined, active: boolean) {
  const [revision, setRevision] = useState(0)
  const retry = useCallback(() => setRevision(value => value + 1), [])
  const [state, setState] = useState<{
    source?: Source<T>
    revision: number
    items: T[]
    error: boolean
  }>({ revision: -1, items: EMPTY, error: false })
  const currentSource = state.source === source && state.revision === revision
  const needsLoad = Boolean(active && source && !currentSource)
  useEffect(() => {
    window.addEventListener(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT, retry)
    return () => window.removeEventListener(LOCAL_PLUGIN_SKILLS_CHANGED_EVENT, retry)
  }, [retry])
  useEffect(() => {
    if (!needsLoad || !source) return
    let current = true
    void Promise.resolve()
      .then(() => {
        if (!current) return
        return source()
      })
      .then(
        items => {
          if (current && items) setState({ source, revision, items, error: false })
        },
        () => {
          if (current) setState({ source, revision, items: EMPTY, error: true })
        }
      )
    return () => {
      current = false
    }
  }, [source, needsLoad, revision])
  return {
    items: active && currentSource ? state.items : EMPTY,
    loading: needsLoad,
    error: active && currentSource && state.error,
    retry,
  }
}
