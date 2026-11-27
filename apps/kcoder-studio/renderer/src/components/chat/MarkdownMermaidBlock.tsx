import { safeErrorDiagnostic } from '@/lib/error-diagnostics'
import { Component, lazy, Suspense } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import type { MermaidErrorComponentProps } from 'streamdown'
import { useTranslation } from '@/hooks/useTranslation'
import { MarkdownCodeBlock } from './MarkdownCodeBlock'

const MermaidRenderer = lazy(() => import('./MarkdownMermaidRenderer').then(module => ({
  default: module.MarkdownMermaidRenderer,
})))

interface MarkdownMermaidBlockProps {
  chart: string
  compact?: boolean
}

export function MarkdownMermaidBlock({ chart, compact = false }: MarkdownMermaidBlockProps) {
  const { t } = useTranslation('common')
  return (
    <MermaidRenderBoundary chart={chart} compact={compact}>
      <Suspense fallback={
        <div data-testid="markdown-mermaid-loading" role="status" aria-busy="true"
          className="my-4 flex min-h-48 items-center justify-center text-sm text-text-secondary">
          {t('common.loading')}
        </div>
      }>
        <MermaidRenderer key={chart} chart={chart} errorComponent={MermaidErrorFallback} />
      </Suspense>
    </MermaidRenderBoundary>
  )
}

export function MermaidErrorFallback({ chart, error }: MermaidErrorComponentProps) {
  return (
    <div
      data-testid="markdown-mermaid-error"
      className="rounded-lg border border-border bg-surface"
    >
      <div
        role="status"
        className="border-b border-border px-3 py-2 font-mono text-xs text-text-secondary"
      >
        {error}
      </div>
      <MarkdownCodeBlock lang="mermaid" compact>
        {chart}
      </MarkdownCodeBlock>
    </div>
  )
}

interface MermaidRenderBoundaryProps {
  chart: string
  compact: boolean
  children: ReactNode
}

interface MermaidRenderBoundaryState {
  error: string | null
}

class MermaidRenderBoundary extends Component<
  MermaidRenderBoundaryProps,
  MermaidRenderBoundaryState
> {
  state: MermaidRenderBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): MermaidRenderBoundaryState {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    console.error('[KCoder Studio] Mermaid rendering failed', safeErrorDiagnostic(error), safeErrorDiagnostic(errorInfo))
  }

  componentDidUpdate(previousProps: MarkdownMermaidBlockProps) {
    if (this.state.error && previousProps.chart !== this.props.chart) {
      this.setState({ error: null })
    }
  }

  render() {
    if (this.state.error) {
      return (
        <MermaidErrorFallback
          chart={this.props.chart}
          error={this.state.error}
          retry={() => this.setState({ error: null })}
        />
      )
    }
    return this.props.children
  }
}
