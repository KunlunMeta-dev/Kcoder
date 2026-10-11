export interface WorkspaceFileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modifiedAt?: string | null
}

export interface WorkspaceTreeResponse {
  path: string
  entries: WorkspaceFileEntry[]
}

export interface WorkspaceTextFileResponse {
  path: string
  name: string
  content: string
  editable: boolean
  revision: string
  truncated: boolean
  size: number
  modifiedAt?: string | null
}

export interface WorkspaceFileChunkResponse {
  path: string
  name: string
  contentBase64: string
  offset: number
  eof: boolean
  size: number
  modifiedAt?: string | null
  revision?: string
}

export interface WorkspaceUploadResult {
  status: 'uploaded' | 'conflict'
  path: string
  name: string
  size: number
  sha256: string
  revision: string | null
}
export interface WorkspaceUploadOptions {
  signal?: AbortSignal
  onPhase?: (phase: 'uploading' | 'saving' | 'confirming') => void
  onProgress?: (sent: number, total: number) => void
  onConflict?: (file: WorkspaceUploadResult) => Promise<boolean>
}

export interface WorkspaceFileApi {
  uploadWorkspaceFile?: (
    deviceId: string,
    workspacePath: string,
    parentPath: string,
    file: File,
    options?: WorkspaceUploadOptions
  ) => Promise<WorkspaceUploadResult>

  listWorkspaceEntries: (deviceId: string, path: string) => Promise<WorkspaceTreeResponse>
  searchWorkspaceEntries?: (
    deviceId: string,
    root: string,
    query: string,
    cancellationToken?: string
  ) => Promise<import('./api').RuntimeWorkspaceSearchResponse>
  readWorkspaceTextFile: (deviceId: string, filePath: string) => Promise<WorkspaceTextFileResponse>
  writeWorkspaceTextFile?: (
    deviceId: string,
    filePath: string,
    content: string,
    expectedRevision: string
  ) => Promise<WorkspaceTextFileResponse>
  createWorkspaceTextFile?: (
    deviceId: string,
    parentPath: string,
    name: string,
    content?: string
  ) => Promise<WorkspaceTextFileResponse>
  createWorkspaceDirectory?: (
    deviceId: string,
    parentPath: string,
    name: string
  ) => Promise<WorkspaceFileEntry>
  renameWorkspaceEntry?: (
    deviceId: string,
    parentPath: string,
    name: string,
    newName: string
  ) => Promise<WorkspaceFileEntry>
  deleteWorkspaceEntry?: (
    deviceId: string,
    parentPath: string,
    name: string,
    recursive?: boolean
  ) => Promise<void>
  readWorkspaceFileChunk?: (
    deviceId: string,
    filePath: string,
    offset: number,
    expectedRevision?: string
  ) => Promise<WorkspaceFileChunkResponse>
}

export interface WorkspaceTarget {
  deviceId: string
  path: string
  source: 'project' | 'runtime'
  taskId?: string | null
  workspaceSource?: 'local' | 'remote' | string | null
}

export interface WorkspaceFileOpenOptions {
  lineStart?: number
  lineEnd?: number
  isDirectory?: boolean
}

export interface WorkspaceFileOpenRequest extends WorkspaceFileOpenOptions {
  id: number
  path: string
  /** Proposed editor target; it is committed only after the dirty guard allows it. */
  target?: WorkspaceTarget
  /** Captured before asynchronous path discovery; rejects superseded owners and accounts. */
  isCurrent?: () => boolean
}

export interface CodeCommentContext {
  id: string
  filePath: string
  fileName: string
  startLine: number
  endLine: number
  selectedText: string
  comment: string
  createdAt: string
}
