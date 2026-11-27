import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { PredicateFields, WorkflowNodeConfigFields } from './WorkflowNodeConfigFields'
import { workflowRouteLabels, type WorkflowDefinition, type WorkflowNode } from './workflowApi'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

test('compound conditions remain editable without raw JSON and retain nested values', () => {
  function Editor() {
    const [value, setValue] = useState<Record<string, unknown> | undefined>({
      op: 'equals',
      pointer: '/input/type',
      value: 'a',
    })
    return (
      <>
        <PredicateFields value={value} onChange={setValue} />
        <output data-testid="value">{JSON.stringify(value)}</output>
      </>
    )
  }
  render(<Editor />)
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'all' } })
  fireEvent.click(screen.getByText('workflowCanvas.addCondition'))
  fireEvent.change(screen.getAllByRole('combobox')[2], { target: { value: 'not' } })
  expect(JSON.parse(screen.getByTestId('value').textContent!)).toEqual({
    op: 'all',
    conditions: [
      { op: 'equals', pointer: '/input/type', value: 'a' },
      { op: 'not', condition: { op: 'exists', pointer: '/input' } },
    ],
  })
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'any' } })
  expect(JSON.parse(screen.getByTestId('value').textContent!).conditions).toHaveLength(2)
})

test('switch routes can be reordered and boolean-looking labels stay strings', () => {
  const initial = {
    switch: {
      cases: [
        { label: 'true', condition: { op: 'exists', pointer: '/input/a' } },
        { label: 'false', condition: { op: 'exists', pointer: '/input/b' } },
      ],
      default: 'other',
    },
  }
  function Editor() {
    const [config, setConfig] = useState<Record<string, unknown>>(initial)
    return (
      <>
        <WorkflowNodeConfigFields
          kind="switch"
          config={config}
          node={{ dependsOn: [] } as unknown as WorkflowNode}
          definition={{ nodes: [] } as unknown as WorkflowDefinition}
          onChange={setConfig}
        />
        <output data-testid="value">{JSON.stringify(config)}</output>
      </>
    )
  }
  render(<Editor />)
  const fields = screen.getByTestId('workflow-switch-fields')
  fireEvent.click(within(fields).getAllByText('workflowCanvas.moveDown')[0])
  const config = JSON.parse(screen.getByTestId('value').textContent!)
  expect(workflowRouteLabels({ config } as WorkflowNode)).toEqual(['false', 'true', 'other'])
  fireEvent.click(within(fields).getByText('workflowCanvas.addRoute'))
  expect(JSON.parse(screen.getByTestId('value').textContent!).switch.cases).toHaveLength(3)
})
