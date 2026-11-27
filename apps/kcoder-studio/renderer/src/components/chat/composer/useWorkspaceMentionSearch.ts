import { useEffect, useMemo, useState } from 'react'
import type { RuntimeWorkspaceSearchItem } from '@/types/api'
import type { WorkspaceFileApi, WorkspaceTarget } from '@/types/workspace-files'

interface WorkspaceSearchState {
  key: string
  owner?: WorkspaceFileApi
  matches: RuntimeWorkspaceSearchItem[]
  loading: boolean
  error: boolean
}

export function useWorkspaceMentionSearch(
  query: string,
  target?: WorkspaceTarget | null,
  workspaceFileApi?: WorkspaceFileApi
) {
  const [searchState, setSearchState] = useState<WorkspaceSearchState>({
    key: '',
    matches: [],
    loading: false,
    error: false,
  })
  const normalizedQuery = query.trim()
  const { deviceId, path } = target ?? {}
  const activeKey = normalizedQuery && target && workspaceFileApi?.searchWorkspaceEntries
    ? `${deviceId}\0${path}\0${normalizedQuery}` : ''

  useEffect(() => {
    const search = workspaceFileApi?.searchWorkspaceEntries
    if (!activeKey || deviceId === undefined || path === undefined || !search) return

    let stale = false
    const searchKey = activeKey
    const cancellationToken = `composer-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = window.setTimeout(() => {
      setSearchState({ key: searchKey, owner: workspaceFileApi, matches: [], loading: true, error: false })
      void search(deviceId, path, normalizedQuery, cancellationToken)
        .then(response => {
          if (!stale) {
            setSearchState({
              key: searchKey,
              owner: workspaceFileApi,
              matches: response.files.slice(0, 50),
              loading: false,
              error: false,
            })
          }
        })
        .catch(() => {
          if (!stale) {
            setSearchState({ key: searchKey, owner: workspaceFileApi, matches: [], loading: false, error: true })
          }
        })
    }, 80)

    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [activeKey, normalizedQuery, deviceId, path, workspaceFileApi])

  const current = searchState.key === activeKey && searchState.owner === workspaceFileApi
  const matches = useMemo(
    () => (activeKey && current ? searchState.matches : []),
    [activeKey, current, searchState.matches]
  )
  return {
    matches,
    loading: Boolean(activeKey) && (!current || searchState.loading),
    error: Boolean(activeKey) && current && searchState.error,
  }
}
