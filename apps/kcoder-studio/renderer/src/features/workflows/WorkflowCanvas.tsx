import { useCallback, useEffect, useRef, useState } from 'react'
import { Maximize2, Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { WorkflowDefinition, WorkflowNode } from './workflowApi'

const WIDTH = 220,
  HEIGHT = 100
export function WorkflowCanvas({
  definition,
  selectedId,
  onSelect,
  onMove,
  disabled,
}: {
  definition: WorkflowDefinition
  selectedId: string | null
  disabled: boolean
  onSelect: (id: string) => void
  onMove: (node: WorkflowNode, revision: number) => void
}) {
  const { t } = useTranslation('common')
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
      <div className="absolute inset-x-3 top-3 z-20 flex items-center justify-end gap-1">
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
          <marker
            id={`workflow-arrow-${definition.id}`}
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="4"
            orient="auto"
          >
            <path d="M0,0 L8,4 L0,8" fill="currentColor" />
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
                  data-testid="workflow-edge"
                  key={`${id}-${node.id}`}
                  d={`M ${a.x + WIDTH} ${a.y + HEIGHT / 2} C ${a.x + WIDTH + 40} ${a.y + HEIGHT / 2}, ${b.x - 40} ${b.y + HEIGHT / 2}, ${b.x} ${b.y + HEIGHT / 2}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  markerEnd={`url(#workflow-arrow-${definition.id})`}
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
          return (
            <button
              type="button"
              key={node.id}
              data-testid={`workflow-node-${node.id}`}
              aria-pressed={selectedId === node.id}
              className="absolute overflow-hidden rounded-xl border border-border bg-background p-3 text-left shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus aria-pressed:border-focus"
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
              <span className="block truncate text-sm font-medium">{node.title || node.id}</span>
              <span className="mt-1 block text-xs text-text-muted">
                {node.agentType} · {node.id}
              </span>
              <span className="mt-1 block truncate text-xs text-text-secondary">
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
