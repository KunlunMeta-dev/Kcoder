import { useEffect, useMemo, useRef } from 'react'
import type { Chart, ChartConfiguration } from 'chart.js'
import { useTranslation } from '@/hooks/useTranslation'

import { safeWidgetPreviewSvg } from './widgetPreviewSvg'

function completedChartJson(source: string): string | undefined {
  if (new TextEncoder().encode(source).byteLength > 16 * 1024) return undefined
  const match = source.match(
    /<script\b[^>]*\bdata-kcoder-chart(?:=["'][^"']*["'])?[^>]*>([\s\S]*?)<\/script\s*>/i
  )
  return match?.[1]
}

function PassiveChart({ source }: { source: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const config = useMemo(() => completedChartJson(source), [source])
  useEffect(() => {
    if (!config || !canvas.current) return
    let cancelled = false
    let chart: Chart | undefined
    void import('chart.js/auto')
      .then(({ default: Chart }) => {
        if (cancelled || !canvas.current) return
        const parsed = JSON.parse(config) as ChartConfiguration
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          !parsed.data ||
          !Array.isArray(parsed.data.datasets) ||
          parsed.data.datasets.length > 32
        )
          return
        const points = parsed.data.datasets.reduce(
          (total, dataset) => total + (Array.isArray(dataset.data) ? dataset.data.length : 0),
          0
        )
        if (points > 2000) return
        chart = new Chart(canvas.current, {
          ...parsed,
          options: {
            ...parsed.options,
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            events: [],
          },
        })
      })
      .catch(() => {
        /* An incomplete or invalid checkpoint remains a passive summary. */
      })
    return () => {
      cancelled = true
      chart?.destroy()
    }
  }, [config])
  return config ? (
    <div className="relative h-36 overflow-hidden" data-testid="widget-chart-checkpoint">
      <canvas ref={canvas} aria-hidden="true" />
    </div>
  ) : null
}

/** Only actual source prefixes and complete data checkpoints are rendered here. */
export function WidgetStreamPreview({
  title,
  summary,
  receivedBytes,
  source,
  format,
  complete,
  truncated,
}: {
  title: string
  summary: string
  receivedBytes?: number
  source?: string
  format?: 'html' | 'svg'
  complete?: boolean
  truncated?: boolean
}) {
  const { t } = useTranslation('chat')
  const svg = useMemo(() => (source ? safeWidgetPreviewSvg(source) : undefined), [source])
  return (
    <div
      className="studio-card-spacing my-2 overflow-hidden rounded-lg border border-border text-sm"
      data-testid="widget-stream-preview"
      role="status"
    >
      <p className="truncate">{title}</p>
      {summary && <p className="mt-1 line-clamp-2 text-text-muted">{summary}</p>}
      {svg ? (
        <img
          className="mt-2 max-h-36 max-w-full"
          src={`data:image/svg+xml,${encodeURIComponent(svg)}`}
          alt={t('widgets.passivePreview', { defaultValue: 'Visualization preview' })}
          data-testid="widget-svg-prefix"
        />
      ) : source && format === 'html' ? (
        <PassiveChart source={source} />
      ) : null}
      <p className="mt-1 text-xs text-text-muted">
        {t(complete ? 'widgets.received' : 'widgets.receiving', {
          defaultValue: complete ? 'Visualization received' : 'Receiving visualization…',
        })}
        {receivedBytes !== undefined && ` · ${receivedBytes.toLocaleString()} B`}
        {truncated &&
          ` · ${t('widgets.previewLimited', { defaultValue: 'Preview limited to received content' })}`}
      </p>
    </div>
  )
}
