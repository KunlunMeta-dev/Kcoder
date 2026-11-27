import { createContext, useContext } from 'react'
import type { HistoricalLocalAttachmentBinding } from '../../../shared/generated/contracts'

export interface MigrationLocalAttachmentSelectionState {
  bindings: HistoricalLocalAttachmentBinding[]
  select: (binding: HistoricalLocalAttachmentBinding, checked: boolean) => void
}
export const MigrationLocalAttachmentSelectionContext = createContext<MigrationLocalAttachmentSelectionState | null>(null)

export function useMigrationLocalAttachmentSelections() {
  return useContext(MigrationLocalAttachmentSelectionContext)
}
