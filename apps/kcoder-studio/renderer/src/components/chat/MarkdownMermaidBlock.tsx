import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { Streamdown, type MermaidErrorComponentProps } from 'streamdown'
import { mermaid } from '@streamdown/mermaid'
import { MarkdownCodeBlock } from './MarkdownCodeBlock'

const MERMAID_PLUGINS = { mermaid }

interface MarkdownMermaidBlockProps {
  chart: string
  compact?: boolean
}

export function MarkdownMermaidBlock({ chart, compact = false }: MarkdownMermaidBlockProps) {
  const fencedChart = `\`\`\`mermaid\n${chart.replace(/\n$/, '')}\n\`\`\``
  return (
    <MermaidRenderBoundary chart={chart} compact={compact}>
      <Streamdown
        key={chart}
        mode="static"
        controls={{ mermaid: { copy: true, download: true, fullscreen: true, panZoom: true } }}
        plugins={MERMAID_PLUGINS}
        mermaid={{ errorComponent: MermaidErrorFallback }}
        linkSafety={{ enabled: false }}
        lineNumbers={false}
      >
        {fencedChart}
      </Streamdown>
    </MermaidRenderBoundary>
  )
}

function MermaidErrorFallback({ chart, error }: MermaidErrorComponentProps) {
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
    console.error('[KCoder Studio] Mermaid rendering failed', error, errorInfo)
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
