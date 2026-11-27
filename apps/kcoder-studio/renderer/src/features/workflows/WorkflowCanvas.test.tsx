import { act, fireEvent, render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

test('batched pan moves survive pointer release and cancellation before React renders', () => {
  const definition = { id: 'pan', nodes: [] } as unknown as WorkflowDefinition
  const { getByTestId } = render(
    <WorkflowCanvas
      definition={definition}
      selectedId={null}
      disabled
      onMove={() => {}}
      onSelect={() => {}}
    />
  )
  const canvas = getByTestId('workflow-canvas')
  canvas.setPointerCapture = vi.fn()
  const pointer = (type: string, x: number) =>
    fireEvent(
      canvas,
      new MouseEvent(type, {
        bubbles: true,
        button: 0,
        clientX: x,
        clientY: x,
      })
    )
  for (const end of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    act(() => {
      pointer('pointerdown', 10)
      pointer('pointermove', 20)
      pointer('pointermove', 30)
      pointer(end, 30)
    })
    expect(canvas).toBeVisible()
    expect(canvas.innerHTML).not.toContain('NaN')
  }
})

test('a snapshot during a drag preserves the local position and sends the original layout CAS', () => {
  const node = { id: 'A', title: 'A', position: { x: 0, y: 0 }, dependsOn: [] }
  const definition = { id: 'drag', revision: 1, nodes: [node] } as WorkflowDefinition
  const onMove = vi.fn()
  const props = { selectedId: 'A', disabled: false, onMove, onSelect: vi.fn() }
  const { getByTestId, rerender } = render(<WorkflowCanvas {...props} definition={definition} />)
  const button = getByTestId('workflow-node-A')
  button.setPointerCapture = vi.fn()
  const pointer = (type: string, x: number) =>
    fireEvent(button, new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: x }))
  pointer('pointerdown', 0)
  pointer('pointermove', 50)
  expect(button.parentElement).toHaveStyle({ left: '50px', top: '50px' })
  rerender(
    <WorkflowCanvas
      {...props}
      definition={{
        ...definition,
        revision: 2,
        nodes: [{ ...node, position: { x: 200, y: 300 } }],
      }}
    />
  )
  expect(button.parentElement).toHaveStyle({ left: '50px', top: '50px' })
  expect(button).toHaveAttribute('aria-pressed', 'true')
  pointer('pointerup', 60)
  expect(onMove).toHaveBeenCalledWith({ ...node, position: { x: 60, y: 60 } }, 1, { x: 0, y: 0 })
})

test('disconnect disabling during a drag prevents any stale layout mutation', () => {
  const node = { id: 'A', title: 'A', position: { x: 0, y: 0 }, dependsOn: [] }
  const definition = { id: 'drag', revision: 1, nodes: [node] } as WorkflowDefinition
  const onMove = vi.fn()
  const props = { selectedId: 'A', definition, onMove, onSelect: vi.fn() }
  const { getByTestId, rerender } = render(<WorkflowCanvas {...props} disabled={false} />)
  const button = getByTestId('workflow-node-A')
  button.setPointerCapture = vi.fn()
  fireEvent(
    button,
    new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 0, clientY: 0 })
  )
  rerender(<WorkflowCanvas {...props} disabled />)
  fireEvent(
    button,
    new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 80, clientY: 80 })
  )
  expect(onMove).not.toHaveBeenCalled()
})

test('agent inspection uses the persisted real agent id and is absent for legacy unmapped nodes', async () => {
  const node = {
    id: 'node-A',
    kind: 'agent',
    title: 'Worker',
    position: { x: 0, y: 0 },
    dependsOn: [],
  }
  const definition = { id: 'flow', nodes: [node] } as WorkflowDefinition
  const onOpenAgent = vi.fn()
  const props = {
    definition,
    selectedId: null,
    disabled: true,
    onMove: vi.fn(),
    onSelect: vi.fn(),
    onOpenAgent,
    runId: 'observed-run',
  }
  const runtime = {
    nodeId: 'node-A',
    agentId: 'actual-agent-42',
    status: 'running',
  } as import('./workflowApi').WorkflowRun['nodeStates'][number]
  const { getByTestId, queryByTestId, rerender } = render(
    <WorkflowCanvas {...props} nodeStates={[runtime]} />
  )
  fireEvent.click(getByTestId('workflow-agent-node-A'))
  expect(onOpenAgent).toHaveBeenCalledWith('actual-agent-42', { runId: 'observed-run', nodeId: 'node-A' })
  expect(onOpenAgent).not.toHaveBeenCalledWith('node-A')
  getByTestId('workflow-agent-node-A').focus()
  await userEvent.keyboard('{Enter}')
  expect(onOpenAgent).toHaveBeenCalledTimes(2)
  expect(getByTestId('workflow-agent-node-A')).toHaveFocus()
  expect(
    getByTestId('workflow-agent-node-A').closest('button')?.parentElement?.closest('button')
  ).toBeNull()
  rerender(<WorkflowCanvas {...props} nodeStates={[{ ...runtime, agentId: null }]} />)
  expect(queryByTestId('workflow-agent-node-A')).not.toBeInTheDocument()
})
