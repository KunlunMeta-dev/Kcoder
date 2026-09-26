import {
  Bot,
  LogIn,
  FileCode2,
  GitBranch,
  GitMerge,
  Repeat2,
  LogOut,
  LoaderCircle,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Maximize2, Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { WorkflowDefinition, WorkflowNode, WorkflowRun } from './workflowApi'

const nodeAppearance = {
  agent: {
    Icon: Bot,
    color: 'text-blue-600 dark:text-blue-300',
    header: 'bg-blue-50 dark:bg-blue-950/50',
    border: 'border-blue-200 dark:border-blue-800',
  },
  input: {
    Icon: LogIn,
    color: 'text-cyan-700 dark:text-cyan-300',
    header: 'bg-cyan-50 dark:bg-cyan-950/50',
    border: 'border-cyan-200 dark:border-cyan-800',
  },
  template: {
    Icon: FileCode2,
    color: 'text-violet-600 dark:text-violet-300',
    header: 'bg-violet-50 dark:bg-violet-950/50',
    border: 'border-violet-200 dark:border-violet-800',
  },
  condition: {
    Icon: GitBranch,
    color: 'text-amber-700 dark:text-amber-300',
    header: 'bg-amber-50 dark:bg-amber-950/50',
    border: 'border-amber-200 dark:border-amber-800',
  },
  merge: {
    Icon: GitMerge,
    color: 'text-indigo-600 dark:text-indigo-300',
    header: 'bg-indigo-50 dark:bg-indigo-950/50',
    border: 'border-indigo-200 dark:border-indigo-800',
  },
  loop: {
    Icon: Repeat2,
    color: 'text-pink-600 dark:text-pink-300',
    header: 'bg-pink-50 dark:bg-pink-950/50',
    border: 'border-pink-200 dark:border-pink-800',
  },
  output: {
    Icon: LogOut,
    color: 'text-teal-700 dark:text-teal-300',
    header: 'bg-teal-50 dark:bg-teal-950/50',
    border: 'border-teal-200 dark:border-teal-800',
  },
}
const WIDTH = 220,
  HEIGHT = 100
export function WorkflowCanvas({
  definition,
  selectedId,
  onSelect,
  onMove,
  disabled,
  nodeStates = [],
}: {
  definition: WorkflowDefinition
  selectedId: string | null
  disabled: boolean
  nodeStates?: WorkflowRun['nodeStates']
  onSelect: (id: string) => void
  onMove: (node: WorkflowNode, revision: number) => void
}) {
  const { t } = useTranslation('common')
  const markerId = `workflow-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const root = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ x: 24, y: 24, zoom: 1 })
  const [moving, setMoving] = useState<{ id: string; x: number; y: number } | null>(null)
  const drag = useRef<{
    node: WorkflowNode
    revision: number
    x: number
    y: number
    zoom: number
  } | null>(null)
  const pan = useRef<{ clientX: number; clientY: number; x: number; y: number } | null>(null)
  useEffect(() => {
    const element = root.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const bounds = element.getBoundingClientRect()
      const x = event.clientX - bounds.left,
        y = event.clientY - bounds.top
      setView(current => {
        const zoom = Math.max(0.2, Math.min(2, current.zoom * Math.exp(-event.deltaY * 0.001)))
        return {
          zoom,
          x: x - ((x - current.x) * zoom) / current.zoom,
          y: y - ((y - current.y) * zoom) / current.zoom,
        }
      })
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [])
  const fit = useCallback(() => {
    const element = root.current
    if (!element || !definition.nodes.length) {
      setView({ x: 24, y: 24, zoom: 1 })
      return
    }
    // Cached panes may mount while hidden. Never fit against a zero-size viewport.
    if (element.clientWidth <= 64 || element.clientHeight <= 64) return
    const minX = Math.min(...definition.nodes.map(node => node.position.x))
    const minY = Math.min(...definition.nodes.map(node => node.position.y))
    const width = Math.max(...definition.nodes.map(node => node.position.x)) + WIDTH - minX
    const height = Math.max(...definition.nodes.map(node => node.position.y)) + HEIGHT - minY
    const zoom = Math.max(
      0.2,
      Math.min(1.5, (element.clientWidth - 64) / width, (element.clientHeight - 64) / height)
    )
    setView({
      zoom,
      x: (element.clientWidth - width * zoom) / 2 - minX * zoom,
      y: (element.clientHeight - height * zoom) / 2 - minY * zoom,
    })
  }, [definition.nodes])
  const fitRef = useRef(fit)
  useEffect(() => {
    fitRef.current = fit
  }, [fit])
  useEffect(() => {
    const element = root.current
    if (!element || typeof ResizeObserver === 'undefined') return
    let frame = 0
    let previousWidth = 0
    let previousHeight = 0
    const observer = new ResizeObserver(() => {
      const width = element.clientWidth
      const height = element.clientHeight
      if (width === previousWidth && height === previousHeight) return
      previousWidth = width
      previousHeight = height
      cancelAnimationFrame(frame)
      if (width > 64 && height > 64) frame = requestAnimationFrame(() => fitRef.current())
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [])
  const previousCount = useRef(0)
  useEffect(() => {
    const previous = previousCount.current
    previousCount.current = definition.nodes.length
    if (definition.nodes.length <= previous) return
    const frame = requestAnimationFrame(fit)
    return () => cancelAnimationFrame(frame)
  }, [definition.nodes.length, fit])
  const position = (node: WorkflowNode) => (moving?.id === node.id ? moving : node.position)
  return (
    <div
      ref={root}
      data-testid="workflow-canvas"
      className="relative min-h-80 min-w-0 flex-1 touch-none overflow-hidden rounded-xl border border-border bg-surface/30"
      style={{
        backgroundImage:
          'radial-gradient(circle, color-mix(in srgb, currentColor 12%, transparent) 1px, transparent 1px)',
        backgroundSize: '20px 20px',
      }}
      onPointerDown={event => {
        if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
        pan.current = { clientX: event.clientX, clientY: event.clientY, x: view.x, y: view.y }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        if (pan.current)
          setView(current => ({
            ...current,
            x: pan.current!.x + event.clientX - pan.current!.clientX,
            y: pan.current!.y + event.clientY - pan.current!.clientY,
          }))
      }}
      onPointerUp={() => {
        pan.current = null
      }}
      onPointerCancel={() => {
        pan.current = null
      }}
    >
      <div className="absolute right-3 top-3 z-20 flex items-center gap-1 rounded-xl border border-border bg-background p-1 shadow-sm">
        <span className="mr-2 text-xs text-text-muted">{Math.round(view.zoom * 100)}%</span>
        <Button
          size="sm"
          variant="secondary"
          aria-label={t('workflowCanvas.zoomOut')}
          onClick={() => setView(value => ({ ...value, zoom: Math.max(0.2, value.zoom / 1.2) }))}
        >
          <Minus />
        </Button>
        <Button
          size="sm"
          variant="secondary"
          aria-label={t('workflowCanvas.zoomIn')}
          onClick={() => setView(value => ({ ...value, zoom: Math.min(2, value.zoom * 1.2) }))}
        >
          <Plus />
        </Button>
        <Button
          size="sm"
          variant="secondary"
          data-testid="workflow-fit"
          aria-label={t('workflowCanvas.fit')}
          onClick={fit}
        >
          <Maximize2 />
        </Button>
      </div>
      <svg
        className="pointer-events-none absolute inset-0 h-full w-full text-text-muted"
        aria-hidden="true"
      >
        <defs>
          <marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8" fill="context-stroke" />
          </marker>
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.zoom})`}>
          {definition.nodes.flatMap(node =>
            node.dependsOn.map(id => {
              const parent = definition.nodes.find(candidate => candidate.id === id)
              if (!parent) return null
              const a = position(parent),
                b = position(node)
              return (
                <path
                  className={
                    nodeStates.find(item => item.nodeId === node.id)?.status === 'failed'
                      ? 'text-red-600 dark:text-red-400'
                      : nodeStates.find(item => item.nodeId === node.id)?.status === 'running'
                        ? 'text-blue-600 dark:text-blue-300'
                        : nodeStates.find(item => item.nodeId === parent.id)?.status === 'completed'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : nodeAppearance[parent.kind ?? 'agent'].color
                  }
                  opacity={selectedId === node.id || selectedId === parent.id ? 0.9 : 0.4}
                  data-testid="workflow-edge"
                  key={`${id}-${node.id}`}
                  d={`M ${a.x + WIDTH} ${a.y + HEIGHT / 2} C ${a.x + WIDTH + 40} ${a.y + HEIGHT / 2}, ${b.x - 40} ${b.y + HEIGHT / 2}, ${b.x} ${b.y + HEIGHT / 2}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  markerEnd={`url(#${markerId})`}
                />
              )
            })
          )}
        </g>
      </svg>
      <div
        className="absolute left-0 top-0"
        style={{
          transform: `translate(${view.x}px,${view.y}px) scale(${view.zoom})`,
          transformOrigin: '0 0',
        }}
      >
        {definition.nodes.map(node => {
          const point = position(node)
          const runtime = nodeStates.find(item => item.nodeId === node.id)
          const kind = node.kind ?? 'agent'
          const appearance = nodeAppearance[kind]
          const Icon = appearance.Icon
          return (
            <button
              type="button"
              key={node.id}
              data-testid={`workflow-node-${node.id}`}
              aria-pressed={selectedId === node.id}
              className={`absolute rounded-xl border bg-background text-left shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus aria-pressed:ring-2 aria-pressed:ring-focus ${appearance.border}`}
              style={{ left: point.x, top: point.y, width: WIDTH, height: HEIGHT }}
              onClick={() => onSelect(node.id)}
              onPointerDown={event => {
                event.stopPropagation()
                if (disabled || event.button !== 0) return
                onSelect(node.id)
                drag.current = {
                  node,
                  revision: definition.revision,
                  x: event.clientX,
                  y: event.clientY,
                  zoom: view.zoom,
                }
                event.currentTarget.setPointerCapture(event.pointerId)
              }}
              onPointerMove={event => {
                if (drag.current?.node.id !== node.id) return
                const current = drag.current
                setMoving({
                  id: node.id,
                  x: current.node.position.x + (event.clientX - current.x) / current.zoom,
                  y: current.node.position.y + (event.clientY - current.y) / current.zoom,
                })
              }}
              onPointerUp={event => {
                const current = drag.current
                drag.current = null
                setMoving(null)
                if (!current || current.node.id !== node.id) return
                const dx = (event.clientX - current.x) / current.zoom,
                  dy = (event.clientY - current.y) / current.zoom
                if (Math.abs(dx) + Math.abs(dy) > 3)
                  onMove(
                    {
                      ...current.node,
                      position: {
                        x: current.node.position.x + dx,
                        y: current.node.position.y + dy,
                      },
                    },
                    current.revision
                  )
              }}
              onPointerCancel={() => {
                drag.current = null
                setMoving(null)
              }}
            >
              <span
                aria-hidden
                className={`absolute -left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 bg-background ${appearance.border}`}
              />
              <span
                aria-hidden
                className={`absolute -right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 bg-background ${appearance.border}`}
              />
              <span
                className={`flex items-center gap-2 rounded-t-xl border-b px-3 py-2 ${appearance.header} ${appearance.border}`}
              >
                <Icon className={`h-4 w-4 shrink-0 ${appearance.color}`} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {node.title || node.id}
                </span>
                {runtime?.status === 'running' && (
                  <LoaderCircle
                    aria-label={t('workflowCanvas.status_running')}
                    className="h-4 w-4 shrink-0 animate-spin text-blue-600 motion-reduce:animate-none dark:text-blue-300"
                  />
                )}
                {runtime?.status === 'completed' && (
                  <CheckCircle2
                    aria-label={t('workflowCanvas.status_completed')}
                    className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                  />
                )}
                {runtime?.status === 'failed' && (
                  <AlertCircle
                    aria-label={t('workflowCanvas.status_failed')}
                    className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400"
                  />
                )}
              </span>
              <span className={`mt-2 block truncate px-3 text-xs ${appearance.color}`}>
                {t(`workflowCanvas.kind_${kind}`)} ·{' '}
                {runtime ? t(`workflowCanvas.status_${runtime.status}`, runtime.status) : node.id}
              </span>
              <span className="mt-1 block truncate px-3 text-xs text-text-secondary">
                {node.prompt || t('workflowCanvas.noPrompt')}
              </span>
            </button>
          )
        })}
      </div>
      {!definition.nodes.length && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-text-muted">
          {t('workflowCanvas.emptyCanvas')}
        </p>
      )}
    </div>
  )
}
