import { useResizableFileTree } from './useResizableWorkspacePanel'
import {
  AppWindow,
  Check,
  ChevronDown,
  FileOutput,
  FilePlus2,
  Folder,
  FolderPlus,
  Folders,
  Loader2,
  Pencil,
  Save,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { MenuPosition } from '@/components/common/ActionMenu'
import { TextInputDialog } from '@/components/common/TextInputDialog'
import { isWorkspaceDirectoryCacheFresh } from '@/features/workbench/workspaceFileDirectoryCache'
import { cn } from '@/lib/utils'
import {
  isLocalTerminalAvailable,
  getCachedLocalFileOpenerIcon,
  getLocalFileOpenerIcon,
  listLocalFileOpeners,
  openLocalFile,
  openLocalFileWithApplication,
  revealLocalFile,
  type LocalFileOpener,
  type LocalFileOpeners,
} from '@/lib/local-terminal'
import { copyTextToClipboard } from '@/lib/clipboard'
import {
  normalizeAbsoluteWorkspacePath,
  relativeWorkspaceFilePath,
  resolveWorkspaceFilePath,
} from '@/lib/workspace-file-path'
import type {
  CodeCommentContext,
  WorkspaceFileApi,
  WorkspaceFileOpenRequest,
  WorkspaceFileOpenOptions,
  WorkspaceFileEntry,
  WorkspaceFileChunkResponse,
  WorkspaceTarget,
  WorkspaceTextFileResponse,
} from '@/types/workspace-files'
import { WorkspaceFilePreview } from './WorkspaceFilePreview'
import { WorkspaceFileTree } from './WorkspaceFileTree'
import {
  WorkspaceFileTreeContextMenu,
  type WorkspaceTreeContextMenuItem,
} from './WorkspaceFileTreeContextMenu'

interface FileWorkspacePanelProps {
  target: WorkspaceTarget | null
  workspaceTargets?: WorkspaceTarget[]
  workspaceFileApi: WorkspaceFileApi
  openFileRequest?: WorkspaceFileOpenRequest | null
  onAddCodeComment: (context: CodeCommentContext) => void
  onSelectWorkspaceTarget?: (target: WorkspaceTarget) => void
}

interface PreviewLineTarget {
  filePath: string
  lineStart: number
  lineEnd?: number
}

interface WorkspaceBinaryPreview {
  path: string
  name: string
  size: number
  modifiedAt?: string | null
  file: File
}

interface FilePreviewLoadingProgress {
  loadedBytes: number
  totalBytes: number | null
}

type WorkspaceEntryDialog =
  | { kind: 'file' | 'directory'; parentPath: string }
  | { kind: 'rename'; parentPath: string; entry: WorkspaceFileEntry }

function FileOpenerIcon({ opener }: { opener: LocalFileOpener }) {
  const source = getCachedLocalFileOpenerIcon(opener.icon_path)

  if (!source) {
    return <AppWindow className="h-4 w-4 shrink-0 text-text-secondary" />
  }

  return <img src={source} alt="" className="h-4 w-4 shrink-0 rounded-[3px]" />
}

const TEXT_FILE_PATTERN =
  /\.(?:c|cc|cpp|cs|css|go|h|hpp|html|htm|java|js|json|jsx|kt|log|md|mjs|py|rb|rs|sh|sql|svg|toml|ts|tsx|txt|xml|ya?ml|zsh)$/i

function isTextFile(path: string) {
  return TEXT_FILE_PATTERN.test(path)
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value)
  return Uint8Array.from(decoded, character => character.charCodeAt(0))
}

function mimeTypeForFileName(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase()
  const types: Record<string, string> = {
    csv: 'text/csv',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    gif: 'image/gif',
    htm: 'text/html',
    html: 'text/html',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    pdf: 'application/pdf',
    png: 'image/png',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    webp: 'image/webp',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
  return types[extension ?? ''] ?? 'application/octet-stream'
}

function workspaceParentPath(path: string): string {
  const normalized = path.replace(/\/+$/, '')
  const separatorIndex = normalized.lastIndexOf('/')
  return separatorIndex > 0 ? normalized.slice(0, separatorIndex) : '/'
}

function createPreviewLineTarget(
  filePath: string,
  options?: WorkspaceFileOpenOptions
): PreviewLineTarget | null {
  if (typeof options?.lineStart !== 'number') return null
  return {
    filePath,
    lineStart: options.lineStart,
    lineEnd: options.lineEnd,
  }
}

export function FileWorkspacePanel({
  target,
  workspaceTargets = [],
  workspaceFileApi,
  openFileRequest,
  onAddCodeComment,
  onSelectWorkspaceTarget,
}: FileWorkspacePanelProps) {
  const { t } = useTranslation('common')
  const {
    width: treeWidth,
    bounds: treeWidthBounds,
    resizing: treeResizing,
    containerRef: splitContainerRef,
    paneRef: treePaneRef,
    separatorRef: treeSeparatorRef,
    handleResizeStart: handleTreeResizeStart,
    handleResizeKey: handleTreeResizeKey,
  } = useResizableFileTree()
  const targetDeviceId = target?.deviceId
  const targetPath = target?.path
  const targetSource = target?.source
  const targetTaskId = target?.taskId
  const targetWorkspaceSource = target?.workspaceSource
  const stableTarget = useMemo<WorkspaceTarget | null>(() => {
    if (!targetDeviceId || !targetPath || !targetSource) return null
    return {
      deviceId: targetDeviceId,
      path: targetPath,
      source: targetSource,
      taskId: targetTaskId,
      workspaceSource: targetWorkspaceSource,
    }
  }, [targetDeviceId, targetPath, targetSource, targetTaskId, targetWorkspaceSource])
  const rootPath = stableTarget?.path ?? ''
  const listWorkspaceEntries = workspaceFileApi.listWorkspaceEntries
  const searchWorkspaceEntries = workspaceFileApi.searchWorkspaceEntries
  const readWorkspaceTextFile = workspaceFileApi.readWorkspaceTextFile
  const readWorkspaceFileChunk = workspaceFileApi.readWorkspaceFileChunk
  const writeWorkspaceTextFile = workspaceFileApi.writeWorkspaceTextFile
  const createWorkspaceTextFile = workspaceFileApi.createWorkspaceTextFile
  const createWorkspaceDirectory = workspaceFileApi.createWorkspaceDirectory
  const renameWorkspaceEntry = workspaceFileApi.renameWorkspaceEntry
  const deleteWorkspaceEntry = workspaceFileApi.deleteWorkspaceEntry
  const [activeDirectoryPath, setActiveDirectoryPath] = useState(target?.path ?? '')
  const [entriesByPath, setEntriesByPath] = useState<Record<string, WorkspaceFileEntry[]>>({})
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [selectedPathIsDirectory, setSelectedPathIsDirectory] = useState(false)
  const [preview, setPreview] = useState<WorkspaceTextFileResponse | null>(null)
  const [binaryPreview, setBinaryPreview] = useState<WorkspaceBinaryPreview | null>(null)
  const [previewLineTarget, setPreviewLineTarget] = useState<PreviewLineTarget | null>(null)
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const [treeError, setTreeError] = useState<string | null>(null)
  const [treeRetryPath, setTreeRetryPath] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewLoadingProgress, setPreviewLoadingProgress] =
    useState<FilePreviewLoadingProgress | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [editedContent, setEditedContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null)
  const [treeSelectionRevision, setTreeSelectionRevision] = useState(0)
  const [openingWorkspace, setOpeningWorkspace] = useState(false)
  const [directoryTreeVisible, setDirectoryTreeVisible] = useState(true)
  const [fileOpeners, setFileOpeners] = useState<(LocalFileOpeners & { filePath: string }) | null>(
    null
  )
  const [fileOpenerMenuOpen, setFileOpenerMenuOpen] = useState(false)
  const [workspaceTargetMenuOpen, setWorkspaceTargetMenuOpen] = useState(false)
  const [entryDialog, setEntryDialog] = useState<WorkspaceEntryDialog | null>(null)
  const [deleteCandidate, setDeleteCandidate] = useState<WorkspaceFileEntry | null>(null)
  const [entryMutationError, setEntryMutationError] = useState<string | null>(null)
  const [deletingEntry, setDeletingEntry] = useState(false)
  const [entryMenu, setEntryMenu] = useState<{
    entry: WorkspaceFileEntry
    position: MenuPosition
    close: () => void
  } | null>(null)
  const [selectedApplicationPath, setSelectedApplicationPath] = useState<string | null>(null)
  const [, setFileOpenerIconCacheVersion] = useState(0)
  const treeRequestSequence = useRef(0)
  const latestTreeRequestByPath = useRef(new Map<string, number>())
  const directoryLoadedAtByPath = useRef(new Map<string, number>())
  const fileRequestSequence = useRef(0)
  const fileOpenerRequestSequence = useRef(0)
  const fileOpenerMenuRef = useRef<HTMLDivElement>(null)
  const workspaceTargetMenuRef = useRef<HTMLDivElement>(null)

  const warmFileOpenerIcons = useCallback(async (openers: LocalFileOpener[]) => {
    for (const opener of openers) {
      if (!opener.icon_path) continue
      try {
        await getLocalFileOpenerIcon(opener.icon_path)
        setFileOpenerIconCacheVersion(version => version + 1)
      } catch {
        // Continue warming remaining application icons after an individual failure.
      }
    }
  }, [])

  const loadFileOpeners = useCallback(
    async (filePath: string) => {
      if (!isLocalTerminalAvailable()) return

      const requestId = fileOpenerRequestSequence.current + 1
      fileOpenerRequestSequence.current = requestId
      try {
        const openers = await listLocalFileOpeners(filePath)
        if (fileOpenerRequestSequence.current !== requestId) return
        setFileOpeners({ ...openers, filePath })
        void warmFileOpenerIcons(openers.applications)
      } catch {
        if (fileOpenerRequestSequence.current === requestId) {
          setFileOpeners(null)
        }
      }
    },
    [warmFileOpenerIcons]
  )

  const loadTree = useCallback(
    async (path: string, forceRefresh = false) => {
      if (!stableTarget) return
      const cachedAt = directoryLoadedAtByPath.current.get(path)
      if (!forceRefresh && isWorkspaceDirectoryCacheFresh(cachedAt)) {
        setExpandedPaths(previous => new Set(previous).add(path))
        return
      }
      const requestId = treeRequestSequence.current + 1
      treeRequestSequence.current = requestId
      latestTreeRequestByPath.current.set(path, requestId)
      setLoadingPaths(previous => {
        const next = new Set(previous)
        next.add(path)
        return next
      })
      setTreeError(null)
      setTreeRetryPath(null)
      try {
        const result = await listWorkspaceEntries(stableTarget.deviceId, path)
        if (latestTreeRequestByPath.current.get(path) !== requestId) return
        const resolvedPath = result.path || path
        setEntriesByPath(previous => ({
          ...previous,
          [resolvedPath]: result.entries,
        }))
        directoryLoadedAtByPath.current.set(resolvedPath, Date.now())
        setExpandedPaths(previous => {
          const next = new Set(previous)
          next.add(resolvedPath)
          return next
        })
        setTreeRetryPath(null)
      } catch (error) {
        if (latestTreeRequestByPath.current.get(path) !== requestId) return
        setTreeError(
          error instanceof Error
            ? error.message
            : t('workbench.workspace_file_load_failed', '加载文件失败')
        )
        setTreeRetryPath(path)
      } finally {
        if (latestTreeRequestByPath.current.get(path) === requestId) {
          setLoadingPaths(previous => {
            const next = new Set(previous)
            next.delete(path)
            return next
          })
        }
      }
    },
    [listWorkspaceEntries, stableTarget, t]
  )

  const openDirectory = useCallback(
    (entry: WorkspaceFileEntry) => {
      if (!entry.isDirectory) return
      fileRequestSequence.current += 1
      setSelectedFilePath(entry.path)
      setSelectedPathIsDirectory(true)
      setActiveDirectoryPath(entry.path)
      setPreview(null)
      setBinaryPreview(null)
      setPreviewLineTarget(null)
      setPreviewError(null)
      setEditing(false)
      setEditedContent('')
      setSaveError(null)
      setTreeError(null)
      setTreeRetryPath(null)

      if (!loadingPaths.has(entry.path)) {
        void loadTree(entry.path)
      }
    },
    [loadTree, loadingPaths]
  )

  const searchFiles = useCallback(
    async (query: string, cancellationToken: string): Promise<WorkspaceFileEntry[]> => {
      if (!stableTarget || !searchWorkspaceEntries) return []
      const response = await searchWorkspaceEntries(
        stableTarget.deviceId,
        stableTarget.path,
        query,
        cancellationToken
      )
      const root = stableTarget.path.replace(/\/+$/, '')
      return response.files.slice(0, 100).map(match => {
        const relativePath = match.path.replace(/\\/g, '/').replace(/^\/+/, '')
        return {
          name: match.fileName,
          path: `${root}/${relativePath}`,
          isDirectory: match.matchType === 'directory',
          size: 0,
        }
      })
    },
    [searchWorkspaceEntries, stableTarget]
  )

  const openFile = useCallback(
    async (entry: WorkspaceFileEntry, options?: WorkspaceFileOpenOptions) => {
      if (!stableTarget || entry.isDirectory) return
      const requestId = fileRequestSequence.current + 1
      const nextLineTarget = createPreviewLineTarget(entry.path, options)
      fileRequestSequence.current = requestId
      setSelectedFilePath(entry.path)
      setSelectedPathIsDirectory(false)
      setSelectedApplicationPath(null)
      setPreviewLineTarget(nextLineTarget)
      setPreviewLoading(true)
      setPreviewLoadingProgress(null)
      setPreviewError(null)
      setPreview(null)
      setEditing(false)
      setEditedContent('')
      setSaveError(null)
      setBinaryPreview(null)
      if (stableTarget.workspaceSource !== 'remote') {
        void loadFileOpeners(entry.path)
      }
      try {
        if (isTextFile(entry.path)) {
          const file = await readWorkspaceTextFile(stableTarget.deviceId, entry.path)
          if (fileRequestSequence.current !== requestId) return
          setPreview(file)
          return
        }
        if (!readWorkspaceFileChunk) {
          throw new Error('Binary file preview is unavailable')
        }
        const chunks: Uint8Array[] = []
        let offset = 0
        let chunk: WorkspaceFileChunkResponse
        do {
          chunk = await readWorkspaceFileChunk(stableTarget.deviceId, entry.path, offset)
          if (fileRequestSequence.current !== requestId) return
          chunks.push(decodeBase64(chunk.contentBase64))
          offset += chunks[chunks.length - 1].byteLength
          setPreviewLoadingProgress({
            loadedBytes: Math.min(offset, chunk.size),
            totalBytes: chunk.size > 0 ? chunk.size : null,
          })
        } while (!chunk.eof)
        if (fileRequestSequence.current !== requestId) return
        setBinaryPreview({
          path: chunk.path,
          name: chunk.name,
          size: chunk.size,
          modifiedAt: chunk.modifiedAt,
          file: new File(
            chunks.map(part => {
              const copy = new Uint8Array(part.byteLength)
              copy.set(part)
              return copy.buffer
            }),
            chunk.name,
            { type: mimeTypeForFileName(chunk.name) }
          ),
        })
      } catch (error) {
        if (fileRequestSequence.current !== requestId) return
        setPreview(null)
        setEditing(false)
        setEditedContent('')
        setSaveError(null)
        setBinaryPreview(null)
        setPreviewLineTarget(null)
        setPreviewError(
          error instanceof Error
            ? error.message
            : t('workbench.workspace_file_preview_failed', '读取文件失败')
        )
      } finally {
        if (fileRequestSequence.current === requestId) {
          setPreviewLoading(false)
          setPreviewLoadingProgress(null)
        }
      }
    },
    [loadFileOpeners, readWorkspaceFileChunk, readWorkspaceTextFile, stableTarget, t]
  )

  const openFilePath = useCallback(
    (path: string, options?: WorkspaceFileOpenOptions) => {
      if (!stableTarget) return
      const resolvedPath = resolveWorkspaceFilePath(stableTarget.path, path)
      if (!resolvedPath) return

      const openDirectoryPath = (entries?: WorkspaceFileEntry[]) => {
        fileRequestSequence.current += 1
        fileOpenerRequestSequence.current += 1
        setSelectedFilePath(resolvedPath)
        setSelectedPathIsDirectory(true)
        setActiveDirectoryPath(resolvedPath)
        setDirectoryTreeVisible(true)
        setPreview(null)
        setBinaryPreview(null)
        setPreviewLineTarget(null)
        setPreviewError(null)
        setPreviewLoading(false)
        setEditing(false)
        setEditedContent('')
        setSaveError(null)
        setFileOpeners(null)
        setFileOpenerMenuOpen(false)
        setSelectedApplicationPath(null)
        if (entries) {
          setEntriesByPath(previous => ({
            ...previous,
            [resolvedPath]: entries,
          }))
          directoryLoadedAtByPath.current.set(resolvedPath, Date.now())
          setExpandedPaths(previous => new Set(previous).add(resolvedPath))
        } else {
          void loadTree(resolvedPath)
        }
      }

      if (options?.isDirectory) {
        openDirectoryPath()
        return
      }

      const openAsFile = () =>
        void openFile(
          {
            name: resolvedPath.split('/').pop() ?? resolvedPath,
            path: resolvedPath,
            isDirectory: false,
            size: 0,
          },
          options
        )

      if (options?.lineStart !== undefined) {
        openAsFile()
        return
      }

      void listWorkspaceEntries(stableTarget.deviceId, workspaceParentPath(resolvedPath)).then(
        result => {
          const entry = result.entries.find(candidate => candidate.path === resolvedPath)
          if (entry?.isDirectory) {
            openDirectoryPath()
            return
          }
          openAsFile()
        },
        openAsFile
      )
    },
    [listWorkspaceEntries, loadTree, openFile, stableTarget]
  )

  const dirty = editing && preview !== null && editedContent !== preview.content

  const refreshDirectory = useCallback(
    async (path: string) => {
      directoryLoadedAtByPath.current.delete(path)
      await loadTree(path, true)
    },
    [loadTree]
  )

  const saveFile = useCallback(async () => {
    if (!stableTarget || !preview || !writeWorkspaceTextFile || !dirty || saving) return !dirty
    setSaving(true)
    setSaveError(null)
    try {
      const saved = await writeWorkspaceTextFile(
        stableTarget.deviceId,
        preview.path,
        editedContent,
        preview.revision
      )
      setPreview(saved)
      setEditedContent(saved.content)
      setEditing(false)
      return true
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : t('workbench.workspace_file_save_failed')
      )
      return false
    } finally {
      setSaving(false)
    }
  }, [dirty, editedContent, preview, saving, stableTarget, t, writeWorkspaceTextFile])

  const navigateWithDirtyGuard = useCallback(
    (action: () => void) => {
      if (dirty) {
        setPendingNavigation(() => action)
        // Pierre updates internal selection before notifying the application; rebuilding the model restores selection to the current edited file.
        setTreeSelectionRevision(revision => revision + 1)
        return
      }
      action()
    },
    [dirty]
  )

  useEffect(() => {
    if (!stableTarget) return
    directoryLoadedAtByPath.current.clear()
    latestTreeRequestByPath.current.clear()
    let cancelled = false
    void Promise.resolve().then(() => {
      if (!cancelled) {
        setEntriesByPath({})
        setExpandedPaths(new Set())
        setActiveDirectoryPath(stableTarget.path)
        setSelectedFilePath(null)
        setSelectedPathIsDirectory(false)
        setPreview(null)
        setEditing(false)
        setEditedContent('')
        setSaveError(null)
        setBinaryPreview(null)
        setPreviewLineTarget(null)
        setTreeError(null)
        setTreeRetryPath(null)
        void loadTree(stableTarget.path)
      }
    })
    return () => {
      cancelled = true
    }
  }, [loadTree, stableTarget])

  useEffect(() => {
    if (!openFileRequest?.path) return
    let cancelled = false
    void Promise.resolve().then(() => {
      if (!cancelled) {
        navigateWithDirtyGuard(() => {
          setDirectoryTreeVisible(false)
          openFilePath(openFileRequest.path, {
            lineStart: openFileRequest.lineStart,
            lineEnd: openFileRequest.lineEnd,
            isDirectory: openFileRequest.isDirectory,
          })
        })
      }
    })
    return () => {
      cancelled = true
    }
  }, [
    navigateWithDirtyGuard,
    openFilePath,
    openFileRequest?.id,
    openFileRequest?.lineEnd,
    openFileRequest?.lineStart,
    openFileRequest?.isDirectory,
    openFileRequest?.path,
  ])

  useEffect(() => {
    if (!dirty) return

    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', preventUnload)
    return () => window.removeEventListener('beforeunload', preventUnload)
  }, [dirty])

  useEffect(() => {
    if (!fileOpenerMenuOpen) return

    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (!fileOpenerMenuRef.current?.contains(event.target as Node)) {
        setFileOpenerMenuOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFileOpenerMenuOpen(false)
    }

    document.addEventListener('pointerdown', closeOnOutsidePointerDown)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointerDown)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [fileOpenerMenuOpen])

  useEffect(() => {
    if (!workspaceTargetMenuOpen) return

    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (!workspaceTargetMenuRef.current?.contains(event.target as Node)) {
        setWorkspaceTargetMenuOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setWorkspaceTargetMenuOpen(false)
    }

    document.addEventListener('pointerdown', closeOnOutsidePointerDown)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointerDown)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [workspaceTargetMenuOpen])

  if (!stableTarget) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-text-muted">
        {t('workbench.workspace_file_no_workspace', '暂无可浏览的工作区')}
      </section>
    )
  }

  const activePreviewLineTarget =
    previewLineTarget && previewLineTarget.filePath === preview?.path ? previewLineTarget : null
  const displayPath = selectedFilePath ?? stableTarget.path
  const canOpenFile =
    stableTarget.workspaceSource !== 'remote' &&
    Boolean(selectedFilePath) &&
    isLocalTerminalAvailable()
  const compatibleFileOpeners =
    !selectedPathIsDirectory && fileOpeners?.filePath === selectedFilePath
      ? fileOpeners.applications
      : []
  const defaultApplicationPath =
    !selectedPathIsDirectory && fileOpeners?.filePath === selectedFilePath
      ? fileOpeners.default_path
      : null
  const activeApplication = compatibleFileOpeners.find(
    opener => opener.path === (selectedApplicationPath ?? defaultApplicationPath)
  )
  const openSelectedFile = async () => {
    if (!selectedFilePath || !canOpenFile || openingWorkspace) return
    setOpeningWorkspace(true)
    try {
      if (activeApplication) {
        await openLocalFileWithApplication(activeApplication.path, selectedFilePath)
      } else {
        await openLocalFile(selectedFilePath)
      }
    } finally {
      setOpeningWorkspace(false)
    }
  }

  const revealSelectedFile = async () => {
    if (!selectedFilePath || !canOpenFile) return
    setFileOpenerMenuOpen(false)
    await revealLocalFile(selectedFilePath)
  }

  const buildEntryMenuItems = (entry: WorkspaceFileEntry): WorkspaceTreeContextMenuItem[] => {
    const items: WorkspaceTreeContextMenuItem[] = [
      {
        id: 'open',
        label: t('workbench.workspace_file_open', '打开'),
        onSelect: () =>
          navigateWithDirtyGuard(() => {
            if (entry.isDirectory) openDirectory(entry)
            else void openFile(entry)
          }),
      },
    ]
    if (canOpenFile) {
      items.push({
        id: 'reveal',
        label: t('workbench.workspace_file_reveal_location', '打开位置'),
        onSelect: () => {
          void revealLocalFile(entry.path)
        },
      })
    }
    if (renameWorkspaceEntry) {
      items.push({
        id: 'rename',
        label: t('workbench.workspace_file_rename', '重命名'),
        onSelect: () =>
          navigateWithDirtyGuard(() =>
            setEntryDialog({
              kind: 'rename',
              parentPath: workspaceParentPath(entry.path),
              entry,
            })
          ),
      })
    }
    if (deleteWorkspaceEntry) {
      items.push({
        id: 'delete',
        label: t('workbench.workspace_file_delete', '删除'),
        onSelect: () => navigateWithDirtyGuard(() => setDeleteCandidate(entry)),
      })
    }
    const relativePath = relativeWorkspaceFilePath(rootPath, entry.path)
    items.push({
      id: 'copy-relative',
      label: t('workbench.workspace_file_copy_relative_path', '复制相对路径'),
      disabled: !relativePath,
      onSelect: () => {
        void copyTextToClipboard(relativePath)
      },
    })
    items.push({
      id: 'copy-absolute',
      label: t('workbench.workspace_file_copy_absolute_path', '复制绝对路径'),
      onSelect: () => {
        void copyTextToClipboard(normalizeAbsoluteWorkspacePath(entry.path, 'invalid file path'))
      },
    })
    return items
  }

  const directoryTreeToggleLabel = directoryTreeVisible
    ? t('workbench.workspace_file_hide_tree')
    : t('workbench.workspace_file_show_tree')
  const selectableWorkspaceTargets = workspaceTargets.filter(
    (candidate, index, targets) =>
      targets.findIndex(
        item => item.deviceId === candidate.deviceId && item.path === candidate.path
      ) === index
  )
  const selectedWorkspaceTargetLabel =
    stableTarget.path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .filter(Boolean)
      .at(-1) || stableTarget.path
  const selectedEntry = selectedFilePath
    ? (Object.values(entriesByPath)
        .flat()
        .find(entry => entry.path === selectedFilePath) ?? null)
    : null
  const entryMutationParentPath =
    selectedPathIsDirectory && selectedFilePath
      ? selectedFilePath
      : selectedFilePath
        ? workspaceParentPath(selectedFilePath)
        : activeDirectoryPath || stableTarget.path

  const submitEntryDialog = async (value: string) => {
    if (!entryDialog) return
    setEntryMutationError(null)
    if (entryDialog.kind === 'file') {
      if (!createWorkspaceTextFile) return
      const created = await createWorkspaceTextFile(
        stableTarget.deviceId,
        entryDialog.parentPath,
        value,
        ''
      )
      await refreshDirectory(entryDialog.parentPath)
      await openFile({
        name: created.name,
        path: created.path,
        isDirectory: false,
        size: created.size,
        modifiedAt: created.modifiedAt,
      })
      return
    }
    if (entryDialog.kind === 'directory') {
      if (!createWorkspaceDirectory) return
      const created = await createWorkspaceDirectory(
        stableTarget.deviceId,
        entryDialog.parentPath,
        value
      )
      await refreshDirectory(entryDialog.parentPath)
      setSelectedFilePath(created.path)
      setSelectedPathIsDirectory(true)
      openDirectory(created)
      return
    }
    if (entryDialog.kind !== 'rename' || !renameWorkspaceEntry) return
    const renamed = await renameWorkspaceEntry(
      stableTarget.deviceId,
      entryDialog.parentPath,
      entryDialog.entry.name,
      value
    )
    await refreshDirectory(entryDialog.parentPath)
    setSelectedFilePath(renamed.path)
    if (renamed.isDirectory) {
      setSelectedPathIsDirectory(true)
      setActiveDirectoryPath(renamed.path)
      setPreview(null)
      setBinaryPreview(null)
    } else {
      await openFile(renamed)
    }
  }

  const deleteSelectedEntry = async () => {
    if (!deleteCandidate || !deleteWorkspaceEntry || deletingEntry) return
    const parentPath = workspaceParentPath(deleteCandidate.path)
    setDeletingEntry(true)
    setEntryMutationError(null)
    try {
      await deleteWorkspaceEntry(
        stableTarget.deviceId,
        parentPath,
        deleteCandidate.name,
        deleteCandidate.isDirectory
      )
      setDeleteCandidate(null)
      if (selectedFilePath === deleteCandidate.path) {
        setSelectedFilePath(parentPath)
        setSelectedPathIsDirectory(true)
        setActiveDirectoryPath(parentPath)
        setPreview(null)
        setBinaryPreview(null)
        setEditing(false)
        setEditedContent('')
      }
      await refreshDirectory(parentPath)
    } catch (error) {
      setEntryMutationError(error instanceof Error ? error.message : String(error))
    } finally {
      setDeletingEntry(false)
    }
  }

  const toggleFileOpenerMenu = async () => {
    if (fileOpenerMenuOpen) {
      setFileOpenerMenuOpen(false)
      return
    }
    if (!selectedFilePath || !canOpenFile) return
    setFileOpenerMenuOpen(true)
    if (selectedPathIsDirectory) return
    if (fileOpeners?.filePath === selectedFilePath) return
    void loadFileOpeners(selectedFilePath)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header
        data-testid="workspace-file-toolbar"
        className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-3"
      >
        <p
          data-testid="workspace-file-path"
          className="min-w-0 truncate text-sm text-text-secondary"
        >
          {displayPath}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          {selectableWorkspaceTargets.length > 1 && onSelectWorkspaceTarget && (
            <div ref={workspaceTargetMenuRef} className="relative">
              <button
                type="button"
                data-testid="workspace-file-root-selector"
                aria-expanded={workspaceTargetMenuOpen}
                aria-label={t('workbench.workspace_file_choose_root')}
                onClick={() => setWorkspaceTargetMenuOpen(open => !open)}
                className="flex h-[30px] max-w-52 items-center gap-1.5 rounded-lg border border-border bg-background px-2 text-sm text-text-primary hover:bg-muted"
              >
                <Folder className="h-4 w-4 shrink-0 text-text-secondary" />
                <span className="min-w-0 truncate">{selectedWorkspaceTargetLabel}</span>
                <ChevronDown className="h-4 w-4 shrink-0 text-text-secondary" />
              </button>
              {workspaceTargetMenuOpen && (
                <div
                  data-testid="workspace-file-root-menu"
                  role="menu"
                  className="absolute right-0 top-9 z-system-popover w-64 rounded-xl border border-border bg-popover p-1.5 shadow-lg"
                >
                  {selectableWorkspaceTargets.map(candidate => {
                    const selected =
                      candidate.deviceId === stableTarget.deviceId &&
                      candidate.path === stableTarget.path
                    const label =
                      candidate.path
                        .replace(/[\\/]+$/, '')
                        .split(/[\\/]/)
                        .filter(Boolean)
                        .at(-1) || candidate.path
                    return (
                      <button
                        key={`${candidate.deviceId}:${candidate.path}`}
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        data-testid={`workspace-file-root-option-${candidate.path}`}
                        title={candidate.path}
                        onClick={() => {
                          setWorkspaceTargetMenuOpen(false)
                          onSelectWorkspaceTarget(candidate)
                        }}
                        className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-text-primary hover:bg-muted"
                      >
                        <Folder className="h-4 w-4 shrink-0 text-text-secondary" />
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                        {selected && <Check className="h-4 w-4 shrink-0" />}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}
          {preview?.editable && writeWorkspaceTextFile && !editing && (
            <button
              type="button"
              data-testid="workspace-file-edit-button"
              onClick={() => {
                setEditedContent(preview.content)
                setSaveError(null)
                setEditing(true)
              }}
              className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary"
            >
              <Pencil className="h-4 w-4" />
              {t('workbench.workspace_file_edit')}
            </button>
          )}
          {createWorkspaceTextFile && (
            <button
              type="button"
              data-testid="workspace-file-create-file-button"
              onClick={() => setEntryDialog({ kind: 'file', parentPath: entryMutationParentPath })}
              className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary"
              aria-label={t('workbench.workspace_file_create_file', '新建文件')}
              title={t('workbench.workspace_file_create_file', '新建文件')}
            >
              <FilePlus2 className="h-4 w-4" />
            </button>
          )}
          {createWorkspaceDirectory && (
            <button
              type="button"
              data-testid="workspace-file-create-directory-button"
              onClick={() =>
                setEntryDialog({ kind: 'directory', parentPath: entryMutationParentPath })
              }
              className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary"
              aria-label={t('workbench.workspace_file_create_directory', '新建文件夹')}
              title={t('workbench.workspace_file_create_directory', '新建文件夹')}
            >
              <FolderPlus className="h-4 w-4" />
            </button>
          )}
          {selectedEntry && renameWorkspaceEntry && (
            <button
              type="button"
              data-testid="workspace-file-rename-button"
              onClick={() =>
                navigateWithDirtyGuard(() =>
                  setEntryDialog({
                    kind: 'rename',
                    parentPath: workspaceParentPath(selectedEntry.path),
                    entry: selectedEntry,
                  })
                )
              }
              className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary"
              aria-label={t('workbench.workspace_file_rename', '重命名')}
              title={t('workbench.workspace_file_rename', '重命名')}
            >
              <Pencil className="h-4 w-4" />
            </button>
          )}
          {selectedEntry && deleteWorkspaceEntry && (
            <button
              type="button"
              data-testid="workspace-file-delete-button"
              onClick={() => navigateWithDirtyGuard(() => setDeleteCandidate(selectedEntry))}
              className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-red-50 hover:text-red-600"
              aria-label={t('workbench.workspace_file_delete', '删除')}
              title={t('workbench.workspace_file_delete', '删除')}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          {editing && (
            <>
              <button
                type="button"
                data-testid="workspace-file-cancel-edit-button"
                onClick={() =>
                  navigateWithDirtyGuard(() => {
                    setEditing(false)
                    setEditedContent(preview?.content ?? '')
                  })
                }
                className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-text-secondary hover:bg-muted"
              >
                <X className="h-4 w-4" />
                {t('workbench.cancel')}
              </button>
              <button
                type="button"
                data-testid="workspace-file-save-button"
                disabled={!dirty || saving}
                onClick={() => void saveFile()}
                className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-2.5 text-sm text-white disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {t('workbench.workspace_file_save')}
              </button>
            </>
          )}
          {canOpenFile && (
            <div
              ref={fileOpenerMenuRef}
              className="relative inline-flex h-[30px] items-center overflow-visible rounded-lg border border-border bg-background"
            >
              <button
                type="button"
                data-testid="workspace-file-open-file-button"
                disabled={openingWorkspace}
                onClick={() => void openSelectedFile()}
                className="flex h-[30px] items-center gap-1.5 rounded-l-lg px-2 text-sm leading-[18px] text-text-primary hover:bg-muted disabled:cursor-wait disabled:opacity-60"
              >
                {openingWorkspace ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : activeApplication ? (
                  <FileOpenerIcon key={activeApplication.path} opener={activeApplication} />
                ) : (
                  <FileOutput className="h-4 w-4" />
                )}
                <span>{t('workbench.workspace_file_open')}</span>
              </button>
              <button
                type="button"
                data-testid="workspace-file-open-file-picker-button"
                onClick={() => void toggleFileOpenerMenu()}
                className="flex h-[30px] w-7 items-center justify-center rounded-r-lg border-l border-border text-text-secondary hover:bg-muted hover:text-text-primary"
                aria-label={t('workbench.workspace_file_choose_opener')}
                aria-expanded={fileOpenerMenuOpen}
              >
                <ChevronDown className="h-4 w-4" />
              </button>
              {fileOpenerMenuOpen && (
                <div
                  data-testid="workspace-file-open-file-picker-menu"
                  role="menu"
                  className="absolute right-0 top-9 z-system-popover max-h-72 w-56 overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-lg"
                >
                  {compatibleFileOpeners.map(opener => (
                    <button
                      key={opener.path}
                      type="button"
                      role="menuitem"
                      data-testid={`workspace-file-open-file-option-${opener.name}`}
                      onClick={() => {
                        setSelectedApplicationPath(opener.path)
                        setFileOpenerMenuOpen(false)
                        void openLocalFileWithApplication(
                          opener.path,
                          selectedFilePath ?? undefined
                        )
                      }}
                      className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs text-text-primary hover:bg-muted"
                    >
                      <FileOpenerIcon opener={opener} />
                      <span className="min-w-0 flex-1 truncate">{opener.name}</span>
                    </button>
                  ))}
                  <div className="my-1 border-t border-border" />
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="workspace-file-reveal-location-button"
                    onClick={() => void revealSelectedFile()}
                    className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs text-text-primary hover:bg-muted"
                  >
                    <Folders className="h-4 w-4 shrink-0 text-text-secondary" />
                    <span>{t('workbench.workspace_file_reveal_location')}</span>
                  </button>
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            data-testid="workspace-file-toggle-tree-button"
            onClick={() => setDirectoryTreeVisible(visible => !visible)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary"
            aria-label={directoryTreeToggleLabel}
            title={directoryTreeToggleLabel}
          >
            <Folders className="h-4 w-4" />
          </button>
        </div>
      </header>
      <div
        ref={splitContainerRef}
        data-testid="workspace-file-split"
        className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        <WorkspaceFilePreview
          file={preview}
          binaryFile={binaryPreview}
          loading={previewLoading}
          loadingProgress={previewLoadingProgress}
          error={previewError}
          onRetry={() => selectedFilePath && openFilePath(selectedFilePath)}
          targetLineStart={activePreviewLineTarget?.lineStart}
          targetLineEnd={activePreviewLineTarget?.lineEnd}
          onAddCodeComment={onAddCodeComment}
          editing={editing}
          editedContent={editedContent}
          onEditedContentChange={setEditedContent}
          onSave={() => void saveFile()}
        />
        {directoryTreeVisible && (
          <div
            ref={treeSeparatorRef}
            data-testid="workspace-file-tree-resize-handle"
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={t('workbench.workspace_file_tree_resize')}
            aria-valuemin={Math.round(treeWidthBounds.min)}
            aria-valuemax={Math.round(treeWidthBounds.max)}
            aria-valuenow={Math.round(treeWidth)}
            onPointerDown={handleTreeResizeStart}
            onKeyDown={handleTreeResizeKey}
            className={cn(
              'relative z-10 w-2 shrink-0 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-border hover:bg-muted focus-visible:bg-focus/15 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus',
              treeResizing && 'bg-focus/15'
            )}
          />
        )}
        <div
          ref={treePaneRef}
          data-testid="workspace-file-tree-container"
          hidden={!directoryTreeVisible}
          style={{ width: treeWidth }}
          className="min-h-0 min-w-0 shrink-0 overflow-hidden"
        >
          <WorkspaceFileTree
            rootPath={rootPath}
            activeDirectoryPath={activeDirectoryPath}
            entriesByPath={entriesByPath}
            expandedPaths={expandedPaths}
            selectedPath={selectedFilePath}
            selectionRevision={treeSelectionRevision}
            loadingPaths={loadingPaths}
            error={treeError}
            onOpenDirectory={entry => navigateWithDirtyGuard(() => openDirectory(entry))}
            onOpenFile={entry => navigateWithDirtyGuard(() => void openFile(entry))}
            onEntryContextMenu={(entry, position, close) =>
              setEntryMenu({ entry, position, close })
            }
            onSearch={searchWorkspaceEntries ? searchFiles : undefined}
            onRefresh={() =>
              navigateWithDirtyGuard(
                () => void loadTree(treeRetryPath ?? activeDirectoryPath, true)
              )
            }
          />
        </div>
      </div>
      {saveError && (
        <div
          data-testid="workspace-file-save-error"
          className="flex items-center justify-between gap-3 border-t border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          <span>{saveError}</span>
          {saveError.toLowerCase().includes('changed on disk') && selectedFilePath && (
            <button
              type="button"
              data-testid="workspace-file-conflict-reload-button"
              className="shrink-0 underline"
              onClick={() => {
                setEditing(false)
                setEditedContent('')
                setSaveError(null)
                openFilePath(selectedFilePath)
              }}
            >
              {t('workbench.workspace_file_reload')}
            </button>
          )}
        </div>
      )}
      {entryMutationError && (
        <div
          data-testid="workspace-file-mutation-error"
          className="border-t border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          {entryMutationError}
        </div>
      )}
      <TextInputDialog
        open={entryDialog !== null}
        title={
          entryDialog?.kind === 'rename'
            ? t('workbench.workspace_file_rename', '重命名')
            : entryDialog?.kind === 'directory'
              ? t('workbench.workspace_file_create_directory', '新建文件夹')
              : t('workbench.workspace_file_create_file', '新建文件')
        }
        label={t('workbench.workspace_file_name', '名称')}
        initialValue={entryDialog?.kind === 'rename' ? entryDialog.entry.name : ''}
        confirmLabel={t('workbench.confirm', '确认')}
        cancelLabel={t('workbench.cancel', '取消')}
        inputTestId="workspace-file-entry-name-input"
        confirmTestId="workspace-file-entry-confirm-button"
        onClose={() => setEntryDialog(null)}
        onSubmit={submitEntryDialog}
      />
      {deleteCandidate && (
        <div className="fixed inset-0 z-system-modal flex items-center justify-center bg-black/35 p-4">
          <div
            role="dialog"
            aria-modal="true"
            data-testid="workspace-file-delete-dialog"
            className="w-full max-w-sm rounded-xl border border-border bg-background p-4 shadow-xl"
          >
            <h2 className="text-base font-semibold text-text-primary">
              {t('workbench.workspace_file_delete_title', '删除这个项目？')}
            </h2>
            <p className="mt-2 break-all text-sm text-text-secondary">{deleteCandidate.path}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="h-8 rounded-md px-3 text-sm hover:bg-muted"
                onClick={() => setDeleteCandidate(null)}
              >
                {t('workbench.cancel', '取消')}
              </button>
              <button
                type="button"
                data-testid="workspace-file-delete-confirm-button"
                disabled={deletingEntry}
                className="h-8 rounded-md bg-red-600 px-3 text-sm text-white disabled:opacity-50"
                onClick={() => void deleteSelectedEntry()}
              >
                {deletingEntry
                  ? t('workbench.deleting', '删除中')
                  : t('workbench.workspace_file_delete', '删除')}
              </button>
            </div>
          </div>
        </div>
      )}
      {pendingNavigation && (
        <div className="fixed inset-0 z-system-modal flex items-center justify-center bg-black/35 p-4">
          <div
            role="dialog"
            aria-modal="true"
            data-testid="workspace-file-unsaved-dialog"
            className="w-full max-w-sm rounded-xl border border-border bg-background p-4 shadow-xl"
          >
            <h2 className="text-base font-semibold text-text-primary">
              {t('workbench.workspace_file_unsaved_title')}
            </h2>
            <p className="mt-2 text-sm text-text-secondary">
              {t('workbench.workspace_file_unsaved_description')}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                data-testid="workspace-file-unsaved-cancel"
                className="h-8 rounded-md px-3 text-sm hover:bg-muted"
                onClick={() => setPendingNavigation(null)}
              >
                {t('workbench.cancel')}
              </button>
              <button
                type="button"
                data-testid="workspace-file-unsaved-discard"
                className="h-8 rounded-md px-3 text-sm text-red-600 hover:bg-muted"
                onClick={() => {
                  const action = pendingNavigation
                  setPendingNavigation(null)
                  setEditing(false)
                  action()
                }}
              >
                {t('workbench.workspace_file_discard')}
              </button>
              <button
                type="button"
                data-testid="workspace-file-unsaved-save"
                disabled={saving}
                className="h-8 rounded-md bg-primary px-3 text-sm text-white disabled:opacity-50"
                onClick={() =>
                  void (async () => {
                    if (await saveFile()) {
                      const action = pendingNavigation
                      setPendingNavigation(null)
                      setEditing(false)
                      action()
                    }
                  })()
                }
              >
                {t('workbench.workspace_file_save')}
              </button>
            </div>
          </div>
        </div>
      )}
      <WorkspaceFileTreeContextMenu
        position={entryMenu?.position ?? null}
        items={entryMenu ? buildEntryMenuItems(entryMenu.entry) : []}
        testIdPrefix="workspace-file-context"
        onClose={() => {
          // Pierre keeps its own (empty) context-menu state open for clicks inside this portal,
          // and that state swallows tree arrow keys until it is closed; close() is a no-op when
          // the menu is already closed.
          entryMenu?.close()
          setEntryMenu(null)
        }}
      />
    </div>
  )
}
