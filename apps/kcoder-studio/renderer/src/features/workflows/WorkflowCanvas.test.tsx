import { render } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { WorkflowCanvas } from './WorkflowCanvas'
import type { WorkflowDefinition } from './workflowApi'
const t = (key: string) => key
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
test('two views of the same workflow own independent SVG arrow markers', () => {
  const definition = {
    id: 'same-flow',
    nodes: [
      { id: 'A', title: 'A', position: { x: 0, y: 0 }, dependsOn: [] },
      { id: 'B', title: 'B', position: { x: 260, y: 0 }, dependsOn: ['A'] },
    ],
  } as WorkflowDefinition
  const view = (
    <WorkflowCanvas
      definition={definition}
      selectedId={null}
      disabled
      onMove={() => {}}
      onSelect={() => {}}
    />
  )
  const { container } = render(
    <>
      {view}
      {view}
    </>
  )
  const canvases = container.querySelectorAll('[data-testid="workflow-canvas"]')
  const ids = [...canvases].map(canvas => {
    const id = canvas.querySelector('marker')!.id
    expect(canvas.querySelector('[marker-end]')).toHaveAttribute('marker-end', `url(#${id})`)
    return id
  })
  expect(new Set(ids).size).toBe(2)
})
