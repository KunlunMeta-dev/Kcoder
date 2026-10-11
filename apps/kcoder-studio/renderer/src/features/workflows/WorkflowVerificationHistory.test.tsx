import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import {
  WorkflowVerificationHistory,
  type WorkflowVersionReferenceView,
} from './WorkflowVerificationHistory'
const t = (key: string) => key
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
const refs: WorkflowVersionReferenceView = {
  definitionId: 'workflow',
  version: 1,
  definitionSha256: 'hash',
  availability: 'saved',
  latest: false,
  currentRevision: 7,
  pinCount: 0,
  pins: [],
  runReferenceCount: 0,
  runs: [],
  canArchive: true,
}
test('explicit archive requires a review dialog and exact version/revision confirmation', async () => {
  const archive = vi.fn().mockResolvedValue(undefined)
  const view = render(
    <WorkflowVerificationHistory
      definitionId="workflow"
      version={1}
      references={refs}
      isCurrent={() => true}
      onInspect={vi.fn()}
      onArchive={archive}
    />
  )
  fireEvent.click(screen.getByTestId('workflow-archive-version'))
  expect(screen.getByRole('dialog')).toBeVisible()
  expect(archive).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('workflow-archive-confirm'))
  await waitFor(() => expect(archive).toHaveBeenCalledWith(1, 7))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  view.unmount()
})
test('latest/pinned/unknown/mismatched references do not expose archive action', () => {
  const view = render(
    <WorkflowVerificationHistory
      definitionId="workflow"
      version={1}
      references={{ ...refs, latest: true }}
      isCurrent={() => true}
      onInspect={vi.fn()}
      onArchive={vi.fn()}
    />
  )
  expect(screen.queryByTestId('workflow-archive-version')).not.toBeInTheDocument()
  view.rerender(
    <WorkflowVerificationHistory
      definitionId="workflow"
      version={1}
      references={{ ...refs, pinCount: 1 }}
      isCurrent={() => true}
      onInspect={vi.fn()}
      onArchive={vi.fn()}
    />
  )
  expect(screen.queryByTestId('workflow-archive-version')).not.toBeInTheDocument()
  view.rerender(
    <WorkflowVerificationHistory
      definitionId="workflow"
      version={1}
      references={{
        ...refs,
        runs: [
          { runId: 'run', definitionId: 'workflow', version: 1, state: 'unknown', resumeCount: 0 },
        ],
      }}
      isCurrent={() => true}
      onInspect={vi.fn()}
      onArchive={vi.fn()}
    />
  )
  expect(screen.queryByTestId('workflow-archive-version')).not.toBeInTheDocument()
  view.rerender(
    <WorkflowVerificationHistory
      definitionId="workflow"
      version={2}
      references={refs}
      isCurrent={() => true}
      onInspect={vi.fn()}
      onArchive={vi.fn()}
    />
  )
  expect(screen.queryByTestId('workflow-archive-version')).not.toBeInTheDocument()
  view.unmount()
})
test('confirmation becomes inert if selected version changes or target disconnects', () => {
  const archive = vi.fn()
  const view = render(
    <WorkflowVerificationHistory
      definitionId="workflow"
      version={1}
      references={refs}
      isCurrent={() => true}
      onInspect={vi.fn()}
      onArchive={archive}
    />
  )
  fireEvent.click(screen.getByTestId('workflow-archive-version'))
  view.rerender(
    <WorkflowVerificationHistory
      definitionId="workflow"
      version={2}
      references={null}
      disabled
      isCurrent={() => false}
      onInspect={vi.fn()}
      onArchive={archive}
    />
  )
  expect(screen.getByTestId('workflow-archive-confirm')).toBeDisabled()
  fireEvent.click(screen.getByTestId('workflow-archive-confirm'))
  expect(archive).not.toHaveBeenCalled()
  view.unmount()
})
