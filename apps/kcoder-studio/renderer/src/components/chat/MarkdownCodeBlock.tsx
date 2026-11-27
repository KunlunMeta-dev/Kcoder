import { useEffect, useState } from 'react'
import type { CSSProperties, HTMLProps, ReactNode } from 'react'
import { ArrowRightToLine, Copy, CopyCheck, TextWrap } from 'lucide-react'

const LANGUAGE_ALIASES: Record<string, string> = {
  cjs: 'javascript',
  cmd: 'bash',
  dockerfile: 'docker',
  js: 'javascript',
  md: 'markdown',
  mjs: 'javascript',
  py: 'python',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  yml: 'yaml',
  zsh: 'bash',
}

const DISPLAY_LANGUAGE_ALIASES: Record<string, string> = {
  markdown: 'md',
}

const CODE_ACTION_BUTTON_CLASS =
  'flex h-7 w-7 select-none items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70'

const CODE_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'

const codeCustomStyle: CSSProperties = {
  margin: 0,
  padding: '0.75rem 1rem',
  background: 'transparent',
  fontSize: 'var(--text-code)',
  lineHeight: '1.8',
  letterSpacing: 0,
  tabSize: 2,
}

const markdownWrapStateByKey = new Map<string, boolean>()

interface MarkdownCodeBlockProps {
  lang?: string
  children: ReactNode
  compact?: boolean
}

export function MarkdownCodeBlock({
  lang = '',
  children,
  compact = false,
}: MarkdownCodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const [highlight, setHighlight] = useState<typeof import('./markdownSyntaxHighlighter') | null>(null)
  useEffect(() => {
    let active = true
    void import('./markdownSyntaxHighlighter').then(module => {
      if (active) setHighlight(module)
    }).catch(() => {
      // Syntax coloring is optional; source and controls remain usable.
    })
    return () => { active = false }
  }, [])
  const colorScheme = useApplicationColorScheme()
  const text = String(children).replace(/\n$/, '')
  const language = normalizeLanguage(lang)
  const canToggleWrap = language === 'markdown'
  const wrapStateKey = canToggleWrap ? getMarkdownWrapStateKey(text, compact) : ''
  const [wrapState, setWrapState] = useState(() => ({
    key: wrapStateKey,
    value: wrapStateKey ? (markdownWrapStateByKey.get(wrapStateKey) ?? false) : false,
  }))
  const storedWrapLines = wrapStateKey ? (markdownWrapStateByKey.get(wrapStateKey) ?? false) : false
  const effectiveWrapLines =
    canToggleWrap && (wrapState.key === wrapStateKey ? wrapState.value : storedWrapLines)
  const displayLanguage = formatDisplayLanguage(language)
  const wrapButtonLabel = effectiveWrapLines ? '禁用自动换行' : '开启自动换行'
  const codeStyle = getCodeCustomStyle(effectiveWrapLines)
  const codeProps = getCodeTagProps(effectiveWrapLines)
  const lineProps = getLineProps(effectiveWrapLines)

  const handleCopy = async () => {
    await copyCodeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const toggleWrapLines = () => {
    if (!wrapStateKey) return
    const nextValue = !effectiveWrapLines
    markdownWrapStateByKey.set(wrapStateKey, nextValue)
    setWrapState({ key: wrapStateKey, value: nextValue })
  }

  return (
    <div
      data-testid="markdown-code-block"
      data-reading-code
      data-color-scheme={colorScheme}
      data-scroll-anchor
      className={[
        'max-w-full select-none overflow-hidden rounded-lg border border-border bg-code-bg text-left text-text-primary shadow-sm',
        compact ? 'mb-1.5' : 'mb-3 mt-2',
      ].join(' ')}
    >
      <div className="flex h-10 select-none items-center justify-between border-b border-border px-3">
        <span
          data-testid="markdown-code-block-language"
          className="select-none text-xs font-medium text-text-secondary"
        >
          {displayLanguage}
        </span>
        <div className="flex items-center gap-1">
          {canToggleWrap ? (
            <button
              type="button"
              onClick={toggleWrapLines}
              className={CODE_ACTION_BUTTON_CLASS}
              aria-label={wrapButtonLabel}
              aria-pressed={effectiveWrapLines}
              title={wrapButtonLabel}
              data-testid="markdown-code-wrap-button"
            >
              {effectiveWrapLines ? (
                <TextWrap className="h-3.5 w-3.5" data-testid="markdown-code-wrap-enabled-icon" />
              ) : (
                <ArrowRightToLine
                  className="h-3.5 w-3.5"
                  data-testid="markdown-code-wrap-disabled-icon"
                />
              )}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void handleCopy()}
            className={CODE_ACTION_BUTTON_CLASS}
            aria-label="复制代码"
            title="复制代码"
            data-testid="markdown-code-copy-button"
          >
            {copied ? (
              <CopyCheck className="h-3.5 w-3.5" data-testid="markdown-code-copy-success-icon" />
            ) : (
              <Copy className="h-3.5 w-3.5" data-testid="markdown-code-copy-icon" />
            )}
          </button>
        </div>
      </div>
      <div
        data-testid="markdown-code-scroll-container"
        data-wrap={effectiveWrapLines ? 'true' : 'false'}
        className={
          effectiveWrapLines
            ? 'max-w-full select-none overflow-x-hidden'
            : 'max-w-full select-none overflow-x-auto'
        }
      >
        {highlight ? <highlight.SyntaxHighlighter
          language={language || 'text'}
          style={colorScheme === 'dark' ? highlight.oneDark : highlight.oneLight}
          customStyle={codeStyle}
          codeTagProps={codeProps}
          lineProps={lineProps}
          PreTag="div"
          showLineNumbers={false}
          wrapLines={effectiveWrapLines}
          wrapLongLines={effectiveWrapLines}
        >
          {text}
        </highlight.SyntaxHighlighter> : (
          <div style={codeStyle}><code {...codeProps}>{text}</code></div>
        )}
      </div>
    </div>
  )
}

type ApplicationColorScheme = 'light' | 'dark'

function getApplicationColorScheme(): ApplicationColorScheme {
  const root = document.documentElement
  return root.dataset.theme === 'dark' || root.classList.contains('dark') ? 'dark' : 'light'
}

function useApplicationColorScheme(): ApplicationColorScheme {
  const [colorScheme, setColorScheme] = useState<ApplicationColorScheme>(() =>
    getApplicationColorScheme()
  )

  useEffect(() => {
    const root = document.documentElement
    const updateColorScheme = () => setColorScheme(getApplicationColorScheme())
    updateColorScheme()
    const observer = new MutationObserver(updateColorScheme)
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme'] })
    return () => observer.disconnect()
  }, [])

  return colorScheme
}

function normalizeLanguage(lang: string): string {
  const value = lang.trim().toLowerCase()
  return LANGUAGE_ALIASES[value] ?? value
}

function formatDisplayLanguage(language: string): string {
  if (!language) return 'text'
  return DISPLAY_LANGUAGE_ALIASES[language] ?? language
}

function getMarkdownWrapStateKey(text: string, compact: boolean): string {
  return `${compact ? 'compact' : 'regular'}:${text.length}:${hashString(text)}`
}

function hashString(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function getCodeCustomStyle(wrapLines: boolean): CSSProperties {
  return {
    ...codeCustomStyle,
    overflowX: wrapLines ? 'hidden' : 'auto',
    whiteSpace: wrapLines ? 'pre-wrap' : 'pre',
    wordBreak: wrapLines ? 'break-word' : 'normal',
    overflowWrap: wrapLines ? 'anywhere' : 'normal',
  }
}

function getCodeTagProps(wrapLines: boolean): HTMLProps<HTMLElement> {
  return {
    className: 'select-text',
    style: {
      fontFamily: CODE_FONT_FAMILY,
      whiteSpace: wrapLines ? 'pre-wrap' : 'pre',
      wordBreak: wrapLines ? 'break-word' : 'normal',
      overflowWrap: wrapLines ? 'anywhere' : 'normal',
    },
  }
}

function getLineProps(wrapLines: boolean): HTMLProps<HTMLElement> | undefined {
  if (!wrapLines) return undefined

  return {
    style: {
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      overflowWrap: 'anywhere',
    },
  }
}

async function copyCodeText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}
