import type { ComponentType } from 'react'
import { Streamdown, type MermaidErrorComponentProps } from 'streamdown'
import { mermaid } from '@streamdown/mermaid'

const MERMAID_PLUGINS = { mermaid }

export function MarkdownMermaidRenderer({ chart, errorComponent }: {
  chart: string
  errorComponent: ComponentType<MermaidErrorComponentProps>
}) {
  const fencedChart = `\`\`\`mermaid\n${chart.replace(/\n$/, '')}\n\`\`\``
  return (
    <Streamdown
      mode="static"
      controls={{ mermaid: { copy: true, download: true, fullscreen: true, panZoom: true } }}
      plugins={MERMAID_PLUGINS}
      mermaid={{ errorComponent }}
      linkSafety={{ enabled: false }}
      lineNumbers={false}
    >
      {fencedChart}
    </Streamdown>
  )
}
