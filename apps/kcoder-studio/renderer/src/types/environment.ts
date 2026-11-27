export interface EnvironmentInfo {
  additions: string
  deletions: string
  executionTarget: 'local' | 'cloud'
  isGitRepository?: boolean
  deviceId?: string
  workspacePath?: string
  workspaceRoots?: string[]
  branchName?: string
  changeSummary?: {
    kind: 'merge-base' | 'head' | 'empty'
    reference: string | null
    commit: string | null
    fileCount: number
    binaryFiles: number
  }
  untrackedFileCount?: number
  createPullRequestUrl?: string
  error?: string
  loading?: boolean
}
