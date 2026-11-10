import type { CodeViewItem } from '@pierre/diffs'
import { CodeView, type CodeViewHandle } from '@pierre/diffs/react'
import engineeringRenderers from '@file-viewer/preset-engineering'
import officeRenderers from '@file-viewer/preset-office'
import liteRenderers from '@file-viewer/preset-lite'
import { MessageSquare } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import type { CodeCommentContext, WorkspaceTextFileResponse, WorkspaceFileCommentController, WorkspaceFileCommentDraft } from '@/types/workspace-files'
import { WorkspaceXMindPreview } from './WorkspaceXMindPreview'
import { WorkspaceTextFileEditor } from './WorkspaceTextFileEditor'
import { WorkspaceDocumentViewer } from './WorkspaceDocumentViewer'

const WORKSPACE_CODE_LINE_HEIGHT = 'calc(var(--text-code) * 1.8)'

const PIERRE_WORKSPACE_CODE_VIEW_CSS = `
  :host {
    --diffs-font-size: var(--text-code);
    --diffs-line-height: ${WORKSPACE_CODE_LINE_HEIGHT};
    --diffs-font-family: var(--font-code);
    --diffs-header-font-family: var(--font-ui);
    --diffs-light-bg: rgb(255 255 255);
    --diffs-light: rgb(26 26 26);
    --diffs-fg-number-override: rgb(140 140 140);
    --diffs-bg-context-override: rgb(255 255 255);
    --diffs-bg-context-gutter-override: rgb(247 247 248);
    --diffs-bg-hover-override: rgb(247 247 248);
    --diffs-scrollbar-gutter-override: 5px;
    --diffs-min-number-column-width: 3ch;
    background: rgb(255 255 255) !important;
  }
  [data-diffs-header],
  [data-diffs-header="default"] {
    min-height: 36px;
    padding-inline: 12px;
    border-bottom: 1px solid rgb(224 224 224);
    font-size: var(--text-sm);
  }
  [data-file],
  pre,
  [data-code] {
    background: rgb(255 255 255);
  }
  [data-code] {
    scrollbar-width: thin;
    scrollbar-color: rgb(224 224 224 / 0.55) transparent;
  }
  [data-code]::-webkit-scrollbar {
    width: 5px;
    height: 5px;
  }
  [data-code]::-webkit-scrollbar-track {
    background: transparent;
  }
  [data-code]::-webkit-scrollbar-thumb {
    background-color: rgb(224 224 224 / 0.55);
    border-radius: 999px;
  }
  [data-gutter] {
    border-right: 1px solid rgb(224 224 224);
    background: rgb(247 247 248);
  }
  [data-column-number] {
    min-width: 2.75rem;
    padding-left: 0;
    padding-right: 0.5rem;
  }
  [data-line-number-content] {
    min-width: 3ch;
  }
  [data-line] {
    padding-left: 0.5rem;
    padding-right: 0.75rem;
  }
  [data-line][data-hovered],
  [data-column-number][data-hovered] {
    background: rgb(247 247 248);
  }
`

interface WorkspaceFilePreviewProps {
  commentController?: WorkspaceFileCommentController
  sourceRevision?: string
  file: WorkspaceTextFileResponse | null
  binaryFile?: {
    path: string
    name: string
    size: number
    file: File
  } | null
  loading: boolean
  loadingProgress?: { loadedBytes: number; totalBytes: number | null } | null
  error?: string | null
  onRetry: () => void
  targetLineStart?: number
  targetLineEnd?: number
  onAddCodeComment: (context: CodeCommentContext) => void
  editing?: boolean
  editedContent?: string
  onEditedContentChange?: (content: string) => void
  onSave?: () => void
}

const FILE_VIEWER_TYPE_BY_MIME: Record<string, string> = {
  'application/epub+zip': 'epub',
  'application/msword': 'doc',
  'application/pdf': 'pdf',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/zip': 'zip',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/webp': 'webp',
  'text/csv': 'csv',
}

function fileViewerTypeFromMime(mimeType: string): string | undefined {
  return FILE_VIEWER_TYPE_BY_MIME[mimeType.split(';', 1)[0].trim().toLowerCase()]
}

const WORKSPACE_FILE_VIEWER_OPTIONS = {
  preset: [officeRenderers, liteRenderers, engineeringRenderers],
  spreadsheet: { worker: false },
  theme: 'light' as const,
}

const WorkspaceBinaryFilePreview = memo(function WorkspaceBinaryFilePreview({
  file,
}: {
  file: NonNullable<WorkspaceFilePreviewProps['binaryFile']>
}) {
  if (/\.xmind$/i.test(file.name)) {
    return (
      <WorkspaceXMindPreview key={`${file.path}:${file.size}`} file={file.file} name={file.name} />
    )
  }

  return (
    <section
      data-testid="workspace-binary-file-preview"
      className="min-w-0 flex-1 overflow-hidden bg-background"
    >
      <WorkspaceDocumentViewer
        key={`${file.path}:${file.size}`}
        file={file.file}
        filename={file.name}
        type={fileViewerTypeFromMime(file.file.type)}
        size={file.size}
        options={WORKSPACE_FILE_VIEWER_OPTIONS}
      />
    </section>
  )
})

interface WorkspaceCodeViewLineSelection {
  id: string
  range: {
    start: number
    end: number
  }
}

interface WorkspaceFilePreviewContentProps {
  sourceRevision?: string
  file: WorkspaceTextFileResponse
  targetLineStart?: number
  targetLineEnd?: number
  commentDraft: WorkspaceFileCommentDraft | null
  onCommentDraftChange: (draft: WorkspaceFileCommentDraft | null) => void
}

function isHtmlFile(file: WorkspaceTextFileResponse) {
  return /\.(?:html?|xhtml)$/i.test(file.name)
}

function WorkspaceHtmlPreview({ file }: { file: WorkspaceTextFileResponse }) {
  return (
    <section
      data-testid="workspace-html-file-preview"
      className="min-w-0 flex-1 overflow-hidden bg-background"
    >
      <iframe
        title={file.name}
        srcDoc={file.content}
        sandbox="allow-forms allow-popups allow-scripts"
        className="h-full w-full border-0 bg-white"
      />
    </section>
  )
}

function normalizeTargetLineRange(
  lineStart: number | undefined,
  lineEnd: number | undefined,
  lineCount: number
): { start: number; end: number } | null {
  if (!Number.isInteger(lineStart) || Number(lineStart) < 1) return null
  const boundedStart = Math.min(Number(lineStart), Math.max(lineCount, 1))
  const rawEnd = Number.isInteger(lineEnd) && Number(lineEnd) >= 1 ? Number(lineEnd) : boundedStart
  const boundedEnd = Math.min(rawEnd, Math.max(lineCount, 1))
  return {
    start: Math.min(boundedStart, boundedEnd),
    end: Math.max(boundedStart, boundedEnd),
  }
}

function WorkspaceFilePreviewContent({
  file,
  targetLineStart,
  targetLineEnd,
  commentDraft,
  sourceRevision,
  onCommentDraftChange,
}: WorkspaceFilePreviewContentProps) {
  const { t } = useTranslation('common')
  const codeViewRef = useRef<CodeViewHandle<undefined>>(null)
  const lineHeightProbeRef = useRef<HTMLSpanElement>(null)
  const [lineHeight, setLineHeight] = useState(20)
  useLayoutEffect(() => {
    const probe = lineHeightProbeRef.current
    if (!probe) return
    const measure = () => {
      const height = probe.getBoundingClientRect().height
      if (height > 0) setLineHeight(current => (current === height ? current : height))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(probe)
    return () => observer.disconnect()
  }, [])
  // CodeView replaces file payloads only when its numeric item version changes.
  const [source, setSource] = useState({ content: file.content, revision: file.revision, version: 0 })
  if (source.content !== file.content || source.revision !== file.revision)
    setSource({ content: file.content, revision: file.revision, version: source.version + 1 })
  const lines = useMemo(() => file.content.split('\n'), [file.content])
  const targetLineRange = useMemo(
    () => normalizeTargetLineRange(targetLineStart, targetLineEnd, lines.length),
    [lines.length, targetLineEnd, targetLineStart]
  )
  const targetLineKey = targetLineRange
    ? `${file.path}:${targetLineRange.start}:${targetLineRange.end}`
    : `${file.path}:none`
  const codeViewItems = useMemo<CodeViewItem[]>(
    () => [
      {
        id: file.path,
        type: 'file',
        file: {
          name: file.path || file.name,
          contents: file.content,
          cacheKey: file.revision ? `${file.path}:${file.revision}` : undefined,
        },
        version: source.version,
      },
    ],
    [file.content, file.name, file.path, file.revision, source.version]
  )
  const activeSelection =
    commentDraft?.filePath === file.path && commentDraft.targetKey === targetLineKey &&
    commentDraft.revision === file.revision && commentDraft.sourceContent === file.content
      ? commentDraft
      : null
  const selectedLines = activeSelection
    ? {
        id: file.path,
        range: {
          start: activeSelection.startLine,
          end: activeSelection.endLine,
        },
      }
    : targetLineRange
      ? {
          id: file.path,
          range: targetLineRange,
        }
      : null

  useEffect(() => {
    if (!targetLineRange) return
    codeViewRef.current?.scrollTo({
      type: 'range',
      id: file.path,
      range: targetLineRange,
      align: 'center',
      behavior: 'instant',
    })
  }, [file.path, targetLineRange])

  const captureLineSelection = (selectionRange: WorkspaceCodeViewLineSelection | null) => {
    if (!selectionRange || selectionRange.id !== file.path) {
      return
    }
    const { range } = selectionRange
    const startLine = Math.min(range.start, range.end)
    const endLine = Math.max(range.start, range.end)
    const selectedText = lines
      .slice(startLine - 1, endLine)
      .join('\n')
      .trim()
    if (!selectedText) {
      return
    }
    onCommentDraftChange({
      filePath: file.path,
      fileName: file.name,
      sourceRevision,
      revision: file.revision,
      sourceContent: file.content,
      targetKey: targetLineKey,
      selectedText,
      startLine,
      endLine,
      comment: commentDraft?.comment ?? '',
    })
  }

  return (
    <section
      data-testid="workspace-file-preview"
      className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background"
    >
      <span
        ref={lineHeightProbeRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute w-0"
        style={{ height: WORKSPACE_CODE_LINE_HEIGHT }}
      />
      <div data-testid="workspace-file-preview-code-view" className="min-h-0 flex-1 bg-background">
        <CodeView
          ref={codeViewRef}
          key={file.path}
          items={codeViewItems}
          selectedLines={selectedLines}
          onSelectedLinesChange={captureLineSelection}
          options={{
            disableFileHeader: false,
            enableLineSelection: true,
            lineHoverHighlight: 'both',
            overflow: 'scroll',
            stickyHeaders: true,
            layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
            itemMetrics: { lineHeight },
            theme: { dark: 'pierre-dark', light: 'pierre-light' },
            themeType: 'light',
            unsafeCSS: PIERRE_WORKSPACE_CODE_VIEW_CSS,
          }}
          renderHeaderMetadata={() =>
            file.truncated ? (
              <span className="text-xs text-amber-700">
                {t('workbench.workspace_file_truncated', '文件过大，仅显示前 256 KiB')}
              </span>
            ) : null
          }
          className="h-full min-h-0 w-full scrollbar-soft"
          style={{ height: '100%', overflow: 'auto' }}
        />
      </div>
    </section>
  )
}

export function WorkspaceFilePreview(props: WorkspaceFilePreviewProps) {
  const { t } = useTranslation('common')
  const [localDraft, setLocalDraft] = useState<WorkspaceFileCommentDraft | null>(null)
  const controller = props.commentController
  const draft = controller ? controller.draft : localDraft
  const rendered = useRef<{ file: WorkspaceFilePreviewProps['file']; controller: typeof controller } | null>(null)
  useLayoutEffect(() => {
    rendered.current = { file: props.file, controller }
    return () => { rendered.current = null }
  }, [controller, props.file])
  const isCurrent = () => rendered.current?.file === props.file &&
    rendered.current?.controller === controller && (!controller || controller.isCurrent())
  const setDraft = (next: WorkspaceFileCommentDraft | null) => {
    if (!isCurrent()) return
    if (controller) controller.setDraft(next)
    else setLocalDraft(next)
  }
  const { file } = props
  const sourceChanged = Boolean(draft && (
    props.loading || props.error || !file || draft.filePath !== file.path ||
    draft.revision !== file.revision || draft.sourceContent !== file.content
  ))
  const addComment = () => {
    if (!draft?.comment.trim() || !isCurrent()) return
    props.onAddCodeComment({
      id: `code-comment-${crypto.randomUUID()}`,
      filePath: draft.filePath,
      fileName: draft.fileName,
      startLine: draft.startLine,
      endLine: draft.endLine,
      selectedText: draft.selectedText,
      comment: draft.comment.trim(),
      ...(draft.revision && { fileRevision: draft.revision }),
      ...(draft.sourceRevision && { sourceRevision: draft.sourceRevision }),
      createdAt: new Date().toISOString(),
    })
    setDraft(null)
  }
  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {props.sourceRevision && <p data-testid="workspace-file-source-version" data-version-state={(!file?.revision || file.truncated) ? 'unknown' : file.revision === props.sourceRevision ? 'matches' : 'changed'} className="px-3 py-2 text-sm text-text-secondary" role="status">{t((!file?.revision || file.truncated) ? 'workbench.workspace_file_source_unknown' : file.revision === props.sourceRevision ? 'workbench.workspace_file_source_matches' : 'workbench.workspace_file_source_changed')}</p>}
      <WorkspaceFilePreviewBody {...props} commentDraft={draft} onCommentDraftChange={setDraft} />
      {controller?.capacityExceeded && <p role="alert" className="px-3 py-2 text-sm text-text-secondary">{t('workbench.workspace_file_comment_capacity')}</p>}
      {draft && (
        <div className="absolute bottom-4 left-4 right-4 max-h-full overflow-y-auto rounded-xl border border-border bg-background p-3 shadow-xl">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-text-primary">
            <MessageSquare className="h-4 w-4" />
            {t('workbench.workspace_file_local_comment')}
          </div>
          <p className="break-all text-xs text-text-secondary">
            {draft.filePath}:{draft.startLine}-{draft.endLine}
          </p>
          {sourceChanged && (
            <p role="status" className="text-xs text-text-secondary" data-testid="workspace-file-comment-source-changed">
              {t('workbench.workspace_file_comment_source_changed')}
            </p>
          )}
          {!draft.revision && (
            <p className="text-xs text-text-secondary">{t('workbench.workspace_file_comment_version_unknown')}</p>
          )}
          <details>
            <summary data-testid="workspace-file-comment-source" className="min-h-11 cursor-pointer rounded py-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60 md:min-h-8 md:py-1">
              {t('workbench.workspace_file_comment_source')}
            </summary>
            {draft.revision && <p className="break-all text-xs text-text-secondary">{t('workbench.workspace_file_comment_version', { revision: draft.revision })}</p>}
            <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words text-xs">{draft.selectedText}</pre>
          </details>
          <textarea
            data-testid="workspace-file-comment-input"
            value={draft.comment}
            maxLength={8192}
            onChange={event => setDraft({ ...draft, comment: event.target.value })}
            aria-label={t('workbench.workspace_file_comment_placeholder')}
            placeholder={t('workbench.workspace_file_comment_placeholder')}
            className="min-h-20 w-full resize-none rounded-lg border border-border bg-surface p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus/60"
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              data-testid="workspace-file-comment-cancel-button"
              className="min-h-11 md:min-h-8"
              onClick={() => setDraft(null)}
            >
              {t('workbench.cancel')}
            </Button>
            <Button
              size="sm"
              data-testid="workspace-file-add-comment-button"
              className="min-h-11 md:min-h-8"
              disabled={!draft.comment.trim()}
              onClick={addComment}
            >
              {t('workbench.comment')}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

function WorkspaceFilePreviewBody({
  file,
  binaryFile,
  loading,
  loadingProgress,
  error,
  onRetry,
  targetLineStart,
  targetLineEnd,
  commentDraft,
  sourceRevision,
  onCommentDraftChange,
  editing = false,
  editedContent = '',
  onEditedContentChange,
  onSave,
}: WorkspaceFilePreviewProps & {
  commentDraft: WorkspaceFileCommentDraft | null
  onCommentDraftChange: (draft: WorkspaceFileCommentDraft | null) => void
}) {
  const { t } = useTranslation('common')

  if (loading) {
    const progress =
      loadingProgress?.totalBytes && loadingProgress.totalBytes > 0
        ? Math.min(
            100,
            Math.round((loadingProgress.loadedBytes / loadingProgress.totalBytes) * 100)
          )
        : null
    return (
      <section className="flex min-w-0 flex-1 items-center justify-center px-6 text-sm text-text-secondary">
        <div className="w-full max-w-xs space-y-2 text-center">
          <p>
            {progress === null
              ? t('workbench.workspace_file_preview_loading', '正在加载文件...')
              : t('workbench.workspace_file_preview_loading_progress', { progress })}
          </p>
          <div
            data-testid="workspace-file-preview-progress"
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
              style={{ width: `${progress ?? 35}%` }}
            />
          </div>
        </div>
      </section>
    )
  }

  if (error) {
    return (
      <section className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 text-sm text-red-500">
        <p>{error}</p>
        <button
          type="button"
          data-testid="workspace-file-preview-retry-button"
          className="underline"
          onClick={onRetry}
        >
          {t('workbench.workspace_file_retry', '重试')}
        </button>
      </section>
    )
  }

  if (!file) {
    if (binaryFile) {
      return <WorkspaceBinaryFilePreview file={binaryFile} />
    }
    return (
      <section className="flex min-w-0 flex-1 items-center justify-center text-sm text-text-muted">
        {t('workbench.workspace_file_preview_empty', '选择文件查看内容')}
      </section>
    )
  }

  if (editing && onEditedContentChange && onSave) {
    return (
      <section className="flex min-w-0 flex-1 overflow-hidden bg-background">
        <WorkspaceTextFileEditor
          key={file.path}
          path={file.path}
          value={editedContent}
          onChange={onEditedContentChange}
          onSave={onSave}
        />
      </section>
    )
  }

  if (isHtmlFile(file)) {
    return <WorkspaceHtmlPreview file={file} />
  }

  return (
    <WorkspaceFilePreviewContent
      key={file.path}
      file={file}
      targetLineStart={targetLineStart}
      targetLineEnd={targetLineEnd}
      commentDraft={commentDraft}
      sourceRevision={sourceRevision}
      onCommentDraftChange={onCommentDraftChange}
    />
  )
}
