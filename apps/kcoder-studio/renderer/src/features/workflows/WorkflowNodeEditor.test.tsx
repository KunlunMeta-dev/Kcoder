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

test('typed template fields update config and invalid advanced JSON blocks saving', async () => {
  const save = vi.fn(async () => false)
  const dirty = vi.fn()
  render(
    <WorkflowNodeEditor
      definition={definition}
      node={node}
      busy={false}
      onSave={save}
      onDelete={vi.fn(async () => true)}
      onDirty={dirty}
    />
  )
  fireEvent.change(screen.getByTestId('workflow-node-kind'), { target: { value: 'template' } })
  expect(screen.queryByTestId('workflow-node-prompt')).not.toBeInTheDocument()
  fireEvent.change(screen.getByTestId('workflow-node-template'), {
    target: { value: 'PPT: {{/input/topic}}' },
  })
  fireEvent.click(screen.getByTestId('workflow-node-save'))
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'template', config: { template: 'PPT: {{/input/topic}}' } }),
    1
  )
  await Promise.resolve()
  expect(dirty).not.toHaveBeenCalledWith(false)
  fireEvent.change(screen.getByTestId('workflow-node-config'), { target: { value: '{broken' } })
  expect(screen.getByTestId('workflow-node-save')).toBeDisabled()
})
