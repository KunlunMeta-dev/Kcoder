import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps, HTMLAttributes, ReactNode } from 'react'
import type { Element as HastElement } from 'hast'
import { FileText, Folder, Link2 } from 'lucide-react'
import { Streamdown } from 'streamdown'
import { createMathPlugin } from '@streamdown/math'
import { cjk } from '@streamdown/cjk'
import { mermaid } from '@streamdown/mermaid'
import 'katex/dist/katex.min.css'
import 'streamdown/styles.css'
import {
  classifyMarkdownLink,
  encodeWorkspaceMarkdownImageSrc,
  getAuthenticatedImageFetchUrl,
  isAuthenticatedAttachmentImageSrc,
  isHtmlFilePath,
  isLocalMarkdownImagePath,
  isWorkspaceMarkdownImagePath,
  localPathFromMarkdownImageSrc,
  localHtmlBrowserUrl,
  resolveDirectMarkdownImageSrc,
  type MarkdownLinkTarget,
} from './assistantMarkdownLinks'
import { MarkdownCodeBlock } from './MarkdownCodeBlock'
import { MarkdownMermaidBlock } from './MarkdownMermaidBlock'
import { MarkdownImagePreview } from './MarkdownImagePreview'
import { CodexInlineVisualizationHost } from './CodexInlineVisualizationHost'
import { splitStaticMarkdownChunks } from './assistantMarkdownWindowing'
import { useBufferedStreamingText } from './useBufferedStreamingText'
import { WorkspaceMarkdownImageLoaderContext } from './workspaceMarkdownImageLoaderContext'
import { splitCodexInlineVisualizations } from '@/lib/codex-directives'
import { openExternalUrl } from '@/lib/external-links'
import { requestEmbeddedBrowserOpen } from '@/lib/embedded-browser'
import { isTauriRuntime } from '@/lib/runtime-environment'
import type { WorkspaceFileOpenOptions } from '@/types/workspace-files'
import type { TurnFileChangesSummary } from '@/types/api'

const ASSISTANT_MARKDOWN_LINK_CLASS = [
  'inline-flex max-w-full items-center gap-1 rounded-md px-0.5 align-baseline',
  'text-sm font-medium leading-5 text-blue-600 no-underline',
  'transition-colors hover:text-blue-700',
  'dark:text-blue-300 dark:hover:text-blue-200',
  '[&_code]:!rounded-none [&_code]:!bg-transparent [&_code]:!px-0 [&_code]:!py-0 [&_code]:!font-[inherit] [&_code]:!text-inherit',
].join(' ')
const CODEX_PLAN_TAG_PATTERN = /<\/?\s*proposed_plan\s*>/gi
const KCODER_STUDIO_MARKDOWN_FILE_LINK_HOST = 'wework.local'
const KCODER_STUDIO_MARKDOWN_FILE_LINK_PATH = '/markdown-file'
const KCODER_STUDIO_MARKDOWN_FILE_LINK_PREFIX = `https://${KCODER_STUDIO_MARKDOWN_FILE_LINK_HOST}${KCODER_STUDIO_MARKDOWN_FILE_LINK_PATH}?path=`
const MARKDOWN_LINK_PATTERN = /(!?)\[([^\]\n]+)\]\(([^)\n]+)\)/g
const STREAMDOWN_PLUGINS = {
  cjk,
  math: createMathPlugin({ singleDollarTextMath: true }),
  mermaid,
}
interface AssistantMarkdownProps {
  content: string
  isStreaming?: boolean
  variant?: 'default' | 'process'
  onOpenFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
  fileChanges?: TurnFileChangesSummary
}

type AssistantMarkdownPart =
  { kind: 'markdown'; content: string } | { kind: 'visualization'; file: string }

export const AssistantMarkdown = memo(function AssistantMarkdown({
  content,
  isStreaming = false,
  variant = 'default',
  onOpenFile,
  fileChanges,
}: AssistantMarkdownProps) {
  const bufferedContent = useBufferedStreamingText(content, isStreaming)
  const windowMarkdown = isTauriRuntime() && variant === 'default'
  const contentParts = useMemo(() => {
    const parts = splitCodexInlineVisualizations(bufferedContent)
    return parts.flatMap<AssistantMarkdownPart>(part => {
      if (part.kind === 'visualization') return [part]
      // Keep chunk boundaries and wrapper types stable as a live response grows.
      const chunks = windowMarkdown ? splitStaticMarkdownChunks(part.content, 0) : [part.content]
      return chunks.map(content => ({ kind: 'markdown', content }))
    })
  }, [bufferedContent, windowMarkdown])
  const openFileRef = useRef(onOpenFile)

  useEffect(() => {
    openFileRef.current = onOpenFile
  }, [onOpenFile])

  const openFile = useCallback((path: string, options?: WorkspaceFileOpenOptions) => {
    if (options) {
      openFileRef.current?.(path, options)
      return
    }
    openFileRef.current?.(path)
  }, [])
  const components = useMemo(
    () => ({
      h1: ({ children }: { children?: ReactNode }) => (
        <h1
          data-scroll-anchor
          className={
            variant === 'process'
              ? 'mb-2 mt-3 text-base font-semibold text-text-primary'
              : 'mb-4 mt-6 text-lg font-semibold text-text-primary'
          }
        >
          {children}
        </h1>
      ),
      h2: ({ children }: { children?: ReactNode }) => (
        <h2
          data-scroll-anchor
          className={
            variant === 'process'
              ? 'mb-1.5 mt-3 text-sm font-semibold text-text-primary'
              : 'mb-3 mt-5 text-base font-semibold text-text-primary'
          }
        >
          {children}
        </h2>
      ),
      h3: ({ children }: { children?: ReactNode }) => (
        <h3
          data-scroll-anchor
          className={
            variant === 'process'
              ? 'mb-1 mt-2 text-sm font-semibold text-text-primary'
              : 'mb-2 mt-4 text-sm font-semibold text-text-primary'
          }
        >
          {children}
        </h3>
      ),
      p: ({ children }: { children?: ReactNode }) => (
        <p
          data-scroll-anchor
          className={`${variant === 'process' ? 'mb-1.5' : 'mb-3'} min-w-0 break-words leading-6`}
        >
          {children}
        </p>
      ),
      ul: ({ children }: { children?: ReactNode }) => (
        <ul
          className={`${variant === 'process' ? 'mb-1.5 space-y-0.5' : 'mb-3 space-y-1.5'} list-disc pl-5`}
        >
          {children}
        </ul>
      ),
      ol: ({ children }: { children?: ReactNode }) => (
        <ol
          className={`${variant === 'process' ? 'mb-1.5 space-y-0.5 pl-5' : 'mb-3 space-y-1.5 pl-8'} list-decimal`}
        >
          {children}
        </ol>
      ),
      li: ({ children }: { children?: ReactNode }) => (
        <li
          data-scroll-anchor
          className={`min-w-0 break-words leading-6 ${variant === 'process' ? '' : 'pl-1'}`}
        >
          {children}
        </li>
      ),
      strong: ({ children }: { children?: ReactNode }) => (
        <strong className="font-semibold">{children}</strong>
      ),
      code: (props: MarkdownCodeProps) => (
        <MarkdownCode {...props} compact={variant === 'process'} />
      ),
      inlineCode: ({ children }: { children?: ReactNode }) => (
        <MarkdownInlineCode compact={variant === 'process'}>{children}</MarkdownInlineCode>
      ),
      blockquote: ({ children }: { children?: ReactNode }) => (
        <blockquote
          data-scroll-anchor
          className={`${variant === 'process' ? 'mb-1.5 pl-3 opacity-80' : 'mb-3 pl-4'} border-l-3 border-border text-text-secondary`}
        >
          {children}
        </blockquote>
      ),
      table: ({ children }: { children?: ReactNode }) => (
        <div data-scroll-anchor className="mb-3 max-w-full overflow-x-auto">
          <table className="w-full min-w-max border-collapse text-chat">{children}</table>
        </div>
      ),
      th: ({ children }: { children?: ReactNode }) => (
        <th className="border-b border-border px-3 py-2 text-left font-semibold">{children}</th>
      ),
      td: ({ children }: { children?: ReactNode }) => (
        <td className="border-b border-border px-3 py-2">{children}</td>
      ),
      a: ({ href, children }: { href?: string; children?: ReactNode }) => (
        <AssistantMarkdownLink href={href} onOpenFile={openFile}>
          {children}
        </AssistantMarkdownLink>
      ),
      img: ({ src, alt }: { src?: string; alt?: string }) => (
        <AssistantMarkdownImage src={src} alt={alt} />
      ),
    }),
    [openFile, variant]
  )

  return (
    <div
      className={`${variant === 'process' ? 'thinking-markdown text-text-secondary' : 'assistant-markdown'} min-w-0 max-w-full break-words`}
    >
      {contentParts.map((part, index) =>
        part.kind === 'visualization' ? (
          <CodexInlineVisualizationHost
            key={`${part.file}-${index}`}
            file={part.file}
            fileChanges={fileChanges}
          />
        ) : windowMarkdown ? (
          <StableMarkdownChunk
            key={`markdown-${index}`}
            content={part.content}
            isStreaming={isStreaming && index === contentParts.length - 1}
            components={components}
          />
        ) : (
          <Streamdown
            key={`markdown-${index}`}
            mode={isStreaming ? 'streaming' : 'static'}
            isAnimating={isStreaming}
            controls={false}
            plugins={STREAMDOWN_PLUGINS}
            linkSafety={{ enabled: false }}
            lineNumbers={false}
            urlTransform={url => url}
            components={components}
          >
            {prepareAssistantMarkdownContent(part.content)}
          </Streamdown>
        )
      )}
    </div>
  )
}, areAssistantMarkdownPropsEqual)

const StableMarkdownChunk = memo(function StableMarkdownChunk({
  content,
  isStreaming,
  components,
}: {
  content: string
  isStreaming: boolean
  components: ComponentProps<typeof Streamdown>['components']
}) {
  // MessageList already virtualizes entire messages. Evicting paragraphs inside
  // a mounted message changes its height and reading anchors during scrolling.
  // Memoized stable chunks keep completed Markdown out of the streaming hot path.
  return (
    <div data-markdown-window-chunk>
      <Streamdown
        mode={isStreaming ? 'streaming' : 'static'}
        isAnimating={isStreaming}
        controls={false}
        plugins={STREAMDOWN_PLUGINS}
        linkSafety={{ enabled: false }}
        lineNumbers={false}
        urlTransform={url => url}
        components={components}
      >
        {prepareAssistantMarkdownContent(content)}
      </Streamdown>
    </div>
  )
})

type MarkdownCodeProps = {
  node?: HastElement
  compact?: boolean
} & HTMLAttributes<HTMLElement>

function MarkdownCode({ className, children, node, compact = false, ...props }: MarkdownCodeProps) {
  const match = /language-(\w*)/.exec(className || '')
  const text = reactNodeToText(children)
  const isBlock =
    ('data-block' in props && Boolean(props['data-block'])) ||
    node?.properties?.dataBlock === 'true' ||
    Boolean(match) ||
    text.includes('\n')
  if (isBlock) {
    const lang = match ? match[1] || '' : ''
    if (lang.toLowerCase() === 'mermaid') {
      return <MarkdownMermaidBlock chart={text} compact={compact} />
    }
    return (
      <MarkdownCodeBlock lang={lang} compact={compact}>
        {text || children}
      </MarkdownCodeBlock>
    )
  }
  return <MarkdownInlineCode compact={compact}>{children}</MarkdownInlineCode>
}

function MarkdownInlineCode({
  children,
  compact = false,
}: {
  children?: ReactNode
  compact?: boolean
}) {
  return (
    <code
      className={`break-words rounded bg-muted px-1.5 py-0.5 font-medium text-text-primary ${compact ? 'text-xs' : 'text-code'}`}
    >
      {children}
    </code>
  )
}

function areAssistantMarkdownPropsEqual(
  previous: AssistantMarkdownProps,
  next: AssistantMarkdownProps
): boolean {
  return (
    previous.content === next.content &&
    previous.isStreaming === next.isStreaming &&
    previous.fileChanges === next.fileChanges &&
    previous.onOpenFile === next.onOpenFile &&
    previous.variant === next.variant
  )
}

function prepareAssistantMarkdownContent(content: string): string {
  return encodeLocalMarkdownLinks(
    encodeWorkspaceMarkdownImages(
      normalizeLatexMarkdown(content.replace(CODEX_PLAN_TAG_PATTERN, ''))
    )
  )
}

function normalizeLatexMarkdown(content: string): string {
  const lines = content.split('\n')
  const output: string[] = []
  let prose: string[] = []

  const flushProse = () => {
    if (prose.length === 0) return
    output.push(normalizeBracketMathDelimiters(prose.join('\n')))
    prose = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const opening = matchMarkdownFence(lines[index])
    if (!opening) {
      prose.push(lines[index])
      continue
    }

    const closingIndex = findClosingMarkdownFence(lines, index + 1, opening)
    if (closingIndex === -1) {
      prose.push(...lines.slice(index))
      break
    }

    flushProse()
    const fencedLines = lines.slice(index, closingIndex + 1)
    if (isLatexFence(opening.info)) {
      const formula = fencedLines.slice(1, -1).join('\n').trim()
      output.push(`$$\n${formula}\n$$`)
    } else {
      output.push(fencedLines.join('\n'))
    }
    index = closingIndex
  }

  flushProse()
  return output.join('\n')
}

interface MarkdownFence {
  marker: '`' | '~'
  length: number
  info: string
}

function matchMarkdownFence(line: string): MarkdownFence | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^\n]*$/)
  if (!match) return null
  return {
    marker: match[1][0] as '`' | '~',
    length: match[1].length,
    info: match[2] ?? '',
  }
}

function findClosingMarkdownFence(
  lines: string[],
  startIndex: number,
  opening: MarkdownFence
): number {
  for (let index = startIndex; index < lines.length; index += 1) {
    const match = lines[index].match(/^ {0,3}(`{3,}|~{3,})\s*$/)
    if (match && match[1][0] === opening.marker && match[1].length >= opening.length) {
      return index
    }
  }
  return -1
}

function isLatexFence(info: string): boolean {
  return /^(?:latex|tex|math)$/i.test(info)
}

function normalizeBracketMathDelimiters(content: string): string {
  let result = ''
  let index = 0
  let inlineCodeTicks = 0

  while (index < content.length) {
    if (content[index] === '`') {
      const ticks = countRepeatedCharacter(content, index, '`')
      if (inlineCodeTicks === 0) inlineCodeTicks = ticks
      else if (inlineCodeTicks === ticks) inlineCodeTicks = 0
      result += content.slice(index, index + ticks)
      index += ticks
      continue
    }

    if (inlineCodeTicks === 0 && isUnescapedBackslash(content, index)) {
      const opening = content[index + 1]
      const closing = opening === '(' ? ')' : opening === '[' ? ']' : null
      if (closing) {
        const closingIndex = findBracketMathClosingDelimiter(content, index + 2, closing)
        if (closingIndex !== -1) {
          const marker = opening === '(' ? '$' : '$$'
          result += marker + content.slice(index + 2, closingIndex) + marker
          index = closingIndex + 2
          continue
        }
      }
    }

    result += content[index]
    index += 1
  }

  return result
}

function findBracketMathClosingDelimiter(
  content: string,
  startIndex: number,
  closing: ')' | ']'
): number {
  let inlineCodeTicks = 0
  for (let index = startIndex; index < content.length; index += 1) {
    if (content[index] === '`') {
      const ticks = countRepeatedCharacter(content, index, '`')
      if (inlineCodeTicks === 0) inlineCodeTicks = ticks
      else if (inlineCodeTicks === ticks) inlineCodeTicks = 0
      index += ticks - 1
      continue
    }
    if (
      inlineCodeTicks === 0 &&
      isUnescapedBackslash(content, index) &&
      content[index + 1] === closing
    ) {
      return index
    }
  }
  return -1
}

function isUnescapedBackslash(content: string, index: number): boolean {
  if (content[index] !== '\\') return false
  let precedingBackslashes = 0
  for (let cursor = index - 1; cursor >= 0 && content[cursor] === '\\'; cursor -= 1) {
    precedingBackslashes += 1
  }
  return precedingBackslashes % 2 === 0
}

function countRepeatedCharacter(content: string, startIndex: number, character: string): number {
  let count = 0
  while (content[startIndex + count] === character) count += 1
  return count
}

function encodeLocalMarkdownLinks(content: string): string {
  return content.replace(MARKDOWN_LINK_PATTERN, (match, imageMarker, label, rawHref) => {
    if (imageMarker) return match
    const href = String(rawHref).trim()
    const target = classifyMarkdownLink(href)
    if (target.kind !== 'file') return match
    return `[${label}](${KCODER_STUDIO_MARKDOWN_FILE_LINK_PREFIX}${encodeURIComponent(href)})`
  })
}

function encodeWorkspaceMarkdownImages(content: string): string {
  return content.replace(MARKDOWN_LINK_PATTERN, (match, imageMarker, label, rawHref) => {
    if (!imageMarker) return match
    const href = String(rawHref).trim()
    if (!isWorkspaceMarkdownImagePath(href) || isLocalMarkdownImagePath(href)) return match
    return `![${label}](${encodeWorkspaceMarkdownImageSrc(href)})`
  })
}

function decodeLocalMarkdownHref(href?: string): string | undefined {
  if (!href) return href
  try {
    const url = new URL(href)
    if (
      url.protocol === 'https:' &&
      url.hostname === KCODER_STUDIO_MARKDOWN_FILE_LINK_HOST &&
      url.pathname === KCODER_STUDIO_MARKDOWN_FILE_LINK_PATH
    ) {
      return url.searchParams.get('path') ?? href
    }
  } catch {
    return href
  }
  return href
}

function reactNodeToText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(reactNodeToText).join('')
  return ''
}

function formatMarkdownLineLabel(target: Extract<MarkdownLinkTarget, { kind: 'file' }>): string {
  if (typeof target.lineStart !== 'number') return ''
  if (typeof target.lineEnd === 'number' && target.lineEnd !== target.lineStart) {
    return `lines ${target.lineStart}-${target.lineEnd}`
  }
  return `line ${target.lineStart}`
}

function formatMarkdownFileTooltip(target: Extract<MarkdownLinkTarget, { kind: 'file' }>): string {
  const lineLabel = formatMarkdownLineLabel(target)
  return lineLabel ? `${target.path} (${lineLabel})` : target.path
}

function getMarkdownFileOpenOptions(
  target: Extract<MarkdownLinkTarget, { kind: 'file' }>
): WorkspaceFileOpenOptions | undefined {
  if (typeof target.lineStart !== 'number' && !target.isDirectory) return undefined
  return {
    lineStart: target.lineStart,
    lineEnd: target.lineEnd,
    isDirectory: target.isDirectory,
  }
}

function getMarkdownFileIcon(path: string): ReactNode {
  if (/\.(?:json|jsonc)(?:[?#].*)?$/i.test(path)) {
    return (
      <span
        aria-hidden="true"
        className="shrink-0 font-mono text-code font-medium"
        data-testid="assistant-markdown-link-icon"
      >
        {'{}'}
      </span>
    )
  }

  if (/\.(?:sh|bash|zsh)(?:[?#].*)?$/i.test(path)) {
    return (
      <span
        aria-hidden="true"
        className="shrink-0 font-mono text-code font-medium"
        data-testid="assistant-markdown-link-icon"
      >
        $
      </span>
    )
  }

  return (
    <FileText
      aria-hidden="true"
      className="h-3.5 w-3.5 shrink-0"
      data-testid="assistant-markdown-link-icon"
    />
  )
}

function AssistantMarkdownLink({
  href,
  onOpenFile,
  children,
}: {
  href?: string
  onOpenFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
  children?: ReactNode
}) {
  const target = classifyMarkdownLink(decodeLocalMarkdownHref(href))
  const icon =
    target.kind === 'file' ? (
      target.isDirectory ? (
        <Folder
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0"
          data-testid="assistant-markdown-link-icon"
        />
      ) : (
        getMarkdownFileIcon(target.path)
      )
    ) : (
      <Link2
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0"
        data-testid="assistant-markdown-link-icon"
      />
    )

  if (target.kind === 'file') {
    const filePath = target.path
    const lineLabel = formatMarkdownLineLabel(target)
    const tooltip = formatMarkdownFileTooltip(target)
    const openOptions = getMarkdownFileOpenOptions(target)
    return (
      <button
        type="button"
        className={`${ASSISTANT_MARKDOWN_LINK_CLASS} group/file-link relative`}
        data-testid="assistant-markdown-link"
        onClick={() => {
          if (isHtmlFilePath(filePath)) {
            const browserUrl = localHtmlBrowserUrl(filePath)
            if (browserUrl && requestEmbeddedBrowserOpen(browserUrl)) return
          }
          if (openOptions) {
            onOpenFile?.(filePath, openOptions)
            return
          }
          onOpenFile?.(filePath)
        }}
        aria-label={tooltip}
      >
        {icon}
        {children}
        {lineLabel ? (
          <span className="shrink-0" data-testid="assistant-markdown-link-line">
            ({lineLabel})
          </span>
        ) : null}
        <span
          data-testid="assistant-markdown-link-tooltip"
          className="pointer-events-none absolute bottom-full left-0 z-30 mb-1 hidden w-max max-w-[min(36rem,calc(100vw-3rem))] whitespace-normal break-all rounded-xl border border-white/10 bg-[#2f2f2f] px-3 py-2 text-left text-sm font-normal leading-5 text-white shadow-lg group-hover/file-link:block group-focus-visible/file-link:block"
        >
          {tooltip}
        </span>
      </button>
    )
  }

  return (
    <a
      href={href}
      className={ASSISTANT_MARKDOWN_LINK_CLASS}
      data-testid="assistant-markdown-link"
      onClick={event => {
        event.preventDefault()
        event.stopPropagation()
        if (!href) return
        void openExternalUrl(href).catch(error => {
          console.error('[KCoder Studio] Failed to open assistant link', error)
        })
      }}
    >
      {icon}
      {children}
    </a>
  )
}

function AssistantMarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const rawSrc = typeof src === 'string' ? src.trim() : ''
  const loadWorkspaceImage = useContext(WorkspaceMarkdownImageLoaderContext)
  const [authenticatedPreview, setAuthenticatedPreview] = useState<{
    rawSrc: string
    url: string
  } | null>(null)
  const [failedImage, setFailedImage] = useState<{
    rawSrc: string
    loader: typeof loadWorkspaceImage
  } | null>(null)
  const [workspacePreview, setWorkspacePreview] = useState<{
    rawSrc: string
    url: string
    loader: typeof loadWorkspaceImage
  } | null>(null)
  const isAuthenticatedSrc = rawSrc ? isAuthenticatedAttachmentImageSrc(rawSrc) : false
  const directSrc = rawSrc ? resolveDirectMarkdownImageSrc(rawSrc) : null
  const workspaceBackedSrc = Boolean(
    loadWorkspaceImage &&
    rawSrc &&
    isWorkspaceMarkdownImagePath(rawSrc) &&
    (!isLocalMarkdownImagePath(rawSrc) || !directSrc)
  )
  const failureLoader = workspaceBackedSrc ? loadWorkspaceImage : null
  const resolvedSrc = isAuthenticatedSrc
    ? authenticatedPreview?.rawSrc === rawSrc
      ? authenticatedPreview.url
      : null
    : workspaceBackedSrc
      ? workspacePreview?.rawSrc === rawSrc && workspacePreview.loader === loadWorkspaceImage
        ? workspacePreview.url
        : null
      : directSrc
  const hasError = failedImage?.rawSrc === rawSrc && failedImage.loader === failureLoader

  useEffect(() => {
    let objectUrl: string | null = null
    let isMounted = true

    if (!rawSrc || !isAuthenticatedSrc) {
      return () => {
        isMounted = false
      }
    }

    async function loadAuthenticatedImage() {
      try {
        const token = localStorage.getItem('auth_token')
        const response = await fetch(getAuthenticatedImageFetchUrl(rawSrc), {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        })

        if (!response.ok) {
          throw new Error(`Failed to load markdown image: ${response.status}`)
        }

        const blob = await response.blob()
        if (!blob.type.startsWith('image/')) {
          throw new Error(`Markdown image response is not an image: ${blob.type || 'unknown'}`)
        }

        objectUrl = URL.createObjectURL(blob)
        if (isMounted) {
          setAuthenticatedPreview({ rawSrc, url: objectUrl })
        } else {
          URL.revokeObjectURL(objectUrl)
        }
      } catch {
        if (isMounted) {
          setFailedImage({ rawSrc, loader: null })
        }
      }
    }

    void loadAuthenticatedImage()

    return () => {
      isMounted = false
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [isAuthenticatedSrc, rawSrc])

  useEffect(() => {
    let objectUrl: string | null = null
    let isMounted = true
    if (!rawSrc || isAuthenticatedSrc || !workspaceBackedSrc || !loadWorkspaceImage) {
      return () => {
        isMounted = false
      }
    }

    void loadWorkspaceImage(localPathFromMarkdownImageSrc(rawSrc))
      .then(blob => {
        if (!blob.type.startsWith('image/'))
          throw new Error('Workspace Markdown file is not an image')
        objectUrl = URL.createObjectURL(blob)
        if (isMounted) {
          setWorkspacePreview({ rawSrc, url: objectUrl, loader: loadWorkspaceImage })
          setFailedImage(current =>
            current?.rawSrc === rawSrc && current.loader === loadWorkspaceImage ? null : current
          )
        } else URL.revokeObjectURL(objectUrl)
      })
      .catch(() => {
        if (isMounted) setFailedImage({ rawSrc, loader: loadWorkspaceImage })
      })

    return () => {
      isMounted = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [isAuthenticatedSrc, loadWorkspaceImage, rawSrc, workspaceBackedSrc])

  if (hasError) {
    return (
      <span
        data-testid="assistant-markdown-image-error"
        className="my-2 inline-flex max-w-full rounded-xl border border-border bg-surface px-3 py-2 text-xs text-text-muted"
      >
        {alt || rawSrc}
      </span>
    )
  }

  if (!resolvedSrc) {
    return (
      <span
        data-testid="assistant-markdown-image-loading"
        className="my-2 inline-flex h-20 w-32 max-w-full items-center justify-center rounded-xl border border-border bg-surface text-xs text-text-muted"
      >
        {alt || 'Image'}
      </span>
    )
  }

  return (
    <MarkdownImagePreview
      src={resolvedSrc}
      rawSrc={rawSrc}
      alt={alt || ''}
      onError={() => setFailedImage({ rawSrc, loader: failureLoader })}
    />
  )
}
