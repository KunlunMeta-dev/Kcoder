import { useCallback, useMemo, useState, type ReactNode } from 'react'
import type { HistoricalLocalAttachmentBinding } from '../../../../shared/generated/contracts'
import { sameHistoricalAttachmentSelection } from '@/kcoder/migrationLocalAttachmentUpload'
import { MigrationLocalAttachmentSelectionContext as Context } from '@/kcoder/migrationLocalAttachmentSelections'

export function MigrationLocalAttachmentSelections({ children, sourceJobId, viewId, targetScope }: {
  children: ReactNode; sourceJobId: string; viewId?: string; targetScope: string
}) {
  const scope = JSON.stringify([targetScope, sourceJobId, viewId ?? null])
  const [state, setState] = useState<{ scope: string; bindings: HistoricalLocalAttachmentBinding[] }>({ scope, bindings: [] })
  const bindings = useMemo(() => state.scope === scope ? state.bindings : [], [state, scope])
  const select = useCallback((binding: HistoricalLocalAttachmentBinding, checked: boolean) => {
    if (!viewId || binding.selection.jobId !== sourceJobId || binding.selection.viewId !== viewId) return
    setState(previous => {
      const before = previous.scope === scope ? previous.bindings : []
      const remaining = before.filter(item => checked
        ? !sameHistoricalAttachmentSelection(item.selection, binding.selection)
        : item.operationId !== binding.operationId)
      if (checked && remaining.length >= 256) return previous
      return { scope, bindings: checked ? [...remaining, binding] : remaining }
    })
  }, [scope, sourceJobId, viewId])
  const value = useMemo(() => ({ bindings, select }), [bindings, select])
  return <Context.Provider value={value}>{children}</Context.Provider>
}
