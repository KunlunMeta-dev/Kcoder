import { useCallback, useMemo, useState } from 'react'
import type { WorkflowReference } from '@/features/workflows/workflowReferences'

const STORAGE_PREFIX = 'kcoder.workflowCards.dismissed:'
const MAX_REMEMBERED = 64

/** A dismissal covers a definition version; a new workflow or version shows the cards again. */
function cardKey(reference: WorkflowReference) {
  return `${reference.id}:${reference.version ?? 'draft'}`
}

function readDismissed(scope: string): readonly string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + scope)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function writeDismissed(scope: string, keys: readonly string[]) {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + scope, JSON.stringify(keys.slice(-MAX_REMEMBERED)))
  } catch {
    // Browser storage is a per-viewer convenience; dismissal still applies for this view.
  }
}

/**
 * Per-conversation dismissal of the composer's workflow cards. This is a local
 * UI preference (like a fold state), never authoritative workflow state.
 */
export function useWorkflowCardsDismissal(scope: string, references: readonly WorkflowReference[]) {
  const [state, setState] = useState<{ scope: string; keys: readonly string[] }>(() => ({
    scope,
    keys: readDismissed(scope),
  }))
  const keys = useMemo(
    () => state.scope === scope ? state.keys : readDismissed(scope),
    [scope, state]
  )
  const dismissed = useMemo(() => {
    if (references.length === 0) return false
    const hidden = new Set(keys)
    return references.every(reference => hidden.has(cardKey(reference)))
  }, [keys, references])
  const dismiss = useCallback(() => {
    const next = [...new Set([...keys, ...readDismissed(scope), ...references.map(cardKey)])]
    writeDismissed(scope, next)
    setState({ scope, keys: next })
  }, [keys, references, scope])
  return { dismissed, dismiss }
}
