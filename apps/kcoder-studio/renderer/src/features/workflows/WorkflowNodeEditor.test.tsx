import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { WorkflowNodeEditor } from './WorkflowNodeEditor'
import type { WorkflowDefinition, WorkflowNode } from './workflowApi'
const node: WorkflowNode = {
  id: 'A',
  title: 'A',
  prompt: 'old',
  agentType: 'general',
  maxTurns: 60,
  position: { x: 0, y: 0 },
  dependsOn: [],
  allowedWritePaths: [],
  acceptanceCriteria: [],
  expectedArtifacts: [],
}
const definition: WorkflowDefinition = {
  id: 'flow',
  title: 'Flow',
  description: '',
  revision: 1,
  status: 'draft',
  nodes: [node],
  createdAtMs: 0,
  updatedAtMs: 0,
}
test('remote polling never overwrites dirty edits or silently rebases their CAS revision', () => {
  const save = vi.fn(async () => true)
  const props = { busy: false, onSave: save, onDelete: vi.fn(async () => true), onDirty: vi.fn() }
  const { rerender } = render(<WorkflowNodeEditor definition={definition} node={node} {...props} />)
  fireEvent.change(screen.getByTestId('workflow-node-prompt'), {
    target: { value: 'my unsaved edit' },
  })
  const updated = { ...node, prompt: 'external update' }
  rerender(
    <WorkflowNodeEditor
      definition={{ ...definition, revision: 2, nodes: [updated] }}
      node={updated}
      {...props}
    />
  )
  expect(screen.getByTestId('workflow-node-prompt')).toHaveValue('my unsaved edit')
  expect(screen.getByTestId('workflow-node-save')).toBeDisabled()
  expect(save).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('workflow-node-reload'))
  expect(screen.getByTestId('workflow-node-prompt')).toHaveValue('external update')
  fireEvent.change(screen.getByTestId('workflow-node-title'), { target: { value: 'New title' } })
  fireEvent.click(screen.getByTestId('workflow-node-save'))
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ title: 'New title' }), 2)
})
