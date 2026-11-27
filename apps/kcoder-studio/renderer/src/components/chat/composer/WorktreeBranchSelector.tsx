import { BranchSelector } from '@/components/common/BranchSelector'
import type { BranchMenuTarget } from '@/components/common/useBranchMenuScope'

interface WorktreeBranchSelectorProps {
  currentBranch?: string
  selectedBranch?: string | null
  loading?: boolean
  target?: BranchMenuTarget | null
  onListBranches: () => Promise<string[]>
  onSelectBranch: (branchName: string | null) => void
}

export function WorktreeBranchSelector({
  currentBranch,
  selectedBranch,
  loading,
  target,
  onListBranches,
  onSelectBranch,
}: WorktreeBranchSelectorProps) {
  const originalBranch = currentBranch?.trim() || ''
  return (
    <BranchSelector
      variant="worktree"
      mobileSheet
      target={target}
      currentBranch={selectedBranch?.trim() || originalBranch}
      loading={loading}
      onListBranches={onListBranches}
      onSelectBranch={branch => onSelectBranch(branch === originalBranch ? null : branch)}
    />
  )
}
