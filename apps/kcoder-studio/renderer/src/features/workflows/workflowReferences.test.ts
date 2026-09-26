import { expect, test } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import { workflowReferences } from './workflowReferences'
const message = (
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: unknown,
  extra = {}
) =>
  ({
    role: 'assistant',
    blocks: [{ id: 'call', type: 'tool', status: 'done', toolName, toolInput, toolOutput }],
    ...extra,
  }) as WorkbenchMessage
test('references come from successful tool results, never user text or failed calls', () => {
  expect(
    workflowReferences([
      message(
        'WorkflowDraft',
        {},
        JSON.stringify({ id: 'flow', title: 'Plan', savedVersion: 1, status: 'saved' }),
        { role: 'user' }
      ),
      { role: 'user', content: '{"definition_id":"forged","version":1}' } as WorkbenchMessage,
    ])
  ).toEqual([])
  const result = workflowReferences([
    message(
      'WorkflowDraft',
      {},
      {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ id: 'flow', title: 'Plan', savedVersion: 1, status: 'saved' }),
          },
        ],
      }
    ),
  ])
  expect(result[0]).toMatchObject({ id: 'flow', version: 1, title: 'Plan' })
})
test('deduplicates updates and pins execution version and run id, including resume activity', () => {
  const result = workflowReferences([
    message(
      'WorkflowDraft',
      {},
      JSON.stringify({ id: 'flow', title: 'Draft', status: 'draft', savedVersion: 1 })
    ),
    message(
      'Workflow',
      { definition_id: 'flow', version: 1 },
      JSON.stringify({ run_id: 'run-1', status: 'running' })
    ),
    message(
      'Workflow',
      { resume: 'run-1' },
      JSON.stringify({ run_id: 'run-1', status: 'running' })
    ),
  ])
  expect(result).toHaveLength(1)
  expect(result[0]).toMatchObject({ id: 'flow', version: 1, runId: 'run-1', activity: 'call' })
})
test('missing arguments produce a non-running conversation reference', () => {
  const result = workflowReferences([
    message(
      'Workflow',
      { definition_id: 'flow', version: 2 },
      JSON.stringify({ status: 'needs_input', missing_fields: [{ name: 'topic' }] })
    ),
  ])
  expect(result).toEqual([{ id: 'flow', version: 2, title: 'flow', needsInput: true }])
})
