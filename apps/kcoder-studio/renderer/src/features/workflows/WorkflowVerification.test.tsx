import examples from '../../../../shared/generated/examples.json'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { WorkflowVerification, type WorkflowVersionVerification } from './WorkflowVerification'
const t = (key: string, values?: Record<string, unknown>) =>
  `${key} ${JSON.stringify(values ?? {})}`
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
const evidence: WorkflowVersionVerification = {
  definitionId: 'definition',
  savedVersion: 1,
  draftStatus: 'new_draft_unverified',
  staticCheck: {
    savedVersion: 1,
    definitionSha256: 'hash',
    checkedAtMs: 1,
    checkedNodes: ['yes', 'no'],
    checks: ['pure_code_syntax'],
    toolContracts: 'not_checked',
  },
  runs: [
    {
      definitionId: 'definition',
      savedVersion: 1,
      definitionSha256: 'hash',
      runId: 'run',
      resumeCount: 0,
      startedAtMs: 1,
      updatedAtMs: 2,
      executionStatus: 'completed',
      checkStatus: 'passed',
      scope: 'configured_result_checks',
      checkedNodes: ['yes'],
      skippedNodes: ['no'],
      inputSha256: 'input-hash',
      privateInputRef: 'private-input',
      modelSnapshot: { model: 'model' },
      interactionModified: true,
    },
  ],
}
test('shows a new draft separately from old saved-version checks and exact coverage', () => {
  const view = render(
    <WorkflowVerification definitionId="definition" version={1} verification={evidence} />
  )
  expect(screen.getByTestId('workflow-new-draft-unverified')).toBeVisible()
  expect(screen.getByText(/workflowVerification.staticPassed/)).toBeVisible()
  expect(screen.getByText(/workflowVerification.check.modified_passed/)).toBeVisible()
  expect(screen.queryByText(/workflowVerification.check.passed/)).not.toBeInTheDocument()
  expect(screen.getByTestId('workflow-checked-run')).toHaveTextContent('yes')
  expect(screen.getByTestId('workflow-checked-run')).not.toHaveTextContent(/"nodes":"no"/)
  expect(screen.getByText(/workflowVerification.scopeValue/)).toBeVisible()
  expect(screen.getByText(/workflowVerification.interactionModified/)).toBeVisible()
  expect(screen.queryByText('private-input')).not.toBeInTheDocument()
  view.unmount()
})
test('does not transfer evidence to a different version, and preparation is a separate action', () => {
  const prepare = vi.fn()
  const view = render(
    <WorkflowVerification
      definitionId="definition"
      version={2}
      verification={evidence}
      onPrepareVerification={prepare}
    />
  )
  expect(screen.getByRole('alert')).toHaveTextContent('workflowVerification.versionMismatch')
  expect(screen.queryByText(/workflowVerification.check.passed/)).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('workflow-prepare-verification'))
  expect(prepare).toHaveBeenCalledTimes(1)
  view.rerender(
    <WorkflowVerification
      definitionId="definition"
      version={2}
      onPrepareVerification={prepare}
      disabled
    />
  )
  expect(screen.getByTestId('workflow-prepare-verification')).toBeDisabled()
  view.unmount()
})
test('shows count and byte budgets separately without automatic cleanup', () => {
  const view = render(
    <WorkflowVerification
      definitionId="definition"
      version={1}
      capacity={{
        backend: 'immutable_objects',
        workflowCount: 230,
        workflowLimit: 256,
        savedVersionCount: 29,
        versionBytes: { definition: 100_000 },
        backupBytes: 2_000_000,
        backupByteLimit: 33_554_432,
        versionsPerWorkflowLimit: 32,
        usedBytes: 4_000_000,
        byteLimit: 8_388_608,
        nearLimit: true,
        versions: { definition: 29 },
      }}
    />
  )
  expect(screen.getByText(/workflowVerification.workflowCapacity/)).toHaveTextContent('230')
  expect(screen.getByText(/workflowVerification.versionCapacity/)).toHaveTextContent('29')
  expect(screen.getByText(/workflowVerification.byteCapacity/)).toHaveTextContent('8,388,608')
  expect(screen.getByText(/workflowVerification.versionBytes/)).toHaveTextContent('100,000')
  expect(screen.getByText(/workflowVerification.backupBytes/)).toHaveTextContent('2,000,000')
  expect(screen.getByRole('status')).toHaveTextContent('workflowVerification.nearCapacity')
  view.unmount()
})
test('does not call a pending or empty configured-check receipt passed', () => {
  const pending = {
    ...evidence,
    runs: [{ ...evidence.runs[0]!, executionStatus: 'running', checkedNodes: [] }],
  }
  const view = render(
    <WorkflowVerification definitionId="definition" version={1} verification={pending} />
  )
  expect(screen.getByText(/workflowVerification.check.incomplete/)).toBeVisible()
  expect(screen.queryByText(/workflowVerification.check.passed/)).not.toBeInTheDocument()
  view.unmount()
})
test('declared scenario scope is separate and a mismatched coverage cannot pass', () => {
  const scene = {
    ...evidence,
    runs: [
      {
        ...evidence.runs[0]!,
        scenario: {
          request: { id: 'true-route', requiredCheckNodes: ['yes'], expectedSkippedNodes: ['no'] },
          status: 'passed',
          scope: 'declared_configured_checks',
        },
      },
    ],
  }
  const view = render(
    <WorkflowVerification definitionId="definition" version={1} verification={scene} />
  )
  expect(screen.getByText(/workflowVerification.scenario /)).toHaveTextContent(
    'workflowVerification.check.modified_passed'
  )
  expect(screen.getByText(/workflowVerification.scenarioScope/)).toHaveTextContent('yes')
  view.rerender(
    <WorkflowVerification
      definitionId="definition"
      version={1}
      verification={{
        ...scene,
        runs: [
          {
            ...scene.runs[0]!,
            scenario: {
              ...scene.runs[0]!.scenario!,
              request: {
                id: 'wrong-route',
                requiredCheckNodes: ['no'],
                expectedSkippedNodes: ['no'],
              },
            },
          },
        ],
      }}
    />
  )
  expect(screen.getByText(/workflowVerification.scenario /)).toHaveTextContent(
    'workflowVerification.check.incomplete'
  )
  view.unmount()
})
test('more evidence keeps the selected version and remains disabled while disconnected', () => {
  const more = vi.fn()
  const paged = { ...evidence, nextOffset: 32, totalRunCount: 41 }
  const view = render(
    <WorkflowVerification
      definitionId="definition"
      version={1}
      verification={paged}
      onLoadMore={more}
    />
  )
  fireEvent.click(screen.getByTestId('workflow-more-evidence'))
  expect(more).toHaveBeenCalledTimes(1)
  view.rerender(
    <WorkflowVerification
      definitionId="definition"
      version={1}
      verification={paged}
      onLoadMore={more}
      disabled
    />
  )
  expect(screen.getByTestId('workflow-more-evidence')).toBeDisabled()
  view.unmount()
})
test('archived historical evidence stays inspectable and cannot silently prepare new execution', () => {
  const prepare = vi.fn()
  const view = render(
    <WorkflowVerification
      definitionId="definition"
      version={1}
      verification={{ ...evidence, availability: 'archived_history' }}
      onPrepareVerification={prepare}
    />
  )
  expect(screen.getByText(/workflowVerification.archivedVersion/)).toBeVisible()
  expect(screen.queryByTestId('workflow-prepare-verification')).not.toBeInTheDocument()
  expect(screen.getByText(/workflowVerification.effectsUnknown/)).toBeVisible()
  expect(prepare).not.toHaveBeenCalled()
  view.unmount()
})

test('shows actual Agent model configuration only for the current run and attempt', () => {
  const actual = examples.WorkflowAgentConfigurationSummary[0].value
  const view = render(
    <WorkflowVerification
      definitionId="definition"
      version={1}
      verification={{
        ...evidence,
        runs: [
          {
            ...evidence.runs[0],
            artifactAttempt: 1,
            modelSnapshot: {
              model: 'admission-model',
              configuration: actual.configuration,
              agents: [{ ...actual, runId: 'run', artifactAttempt: 1 }],
            },
          },
        ],
      }}
    />
  )
  expect(screen.getByTestId('workflow-agent-model-configuration')).toHaveTextContent(
    'workflow-agent-1'
  )
  expect(screen.getByTestId('workflow-agent-model-configuration')).toHaveTextContent(
    'workflowVerification.inheritedModel'
  )
  view.rerender(
    <WorkflowVerification
      definitionId="definition"
      version={1}
      verification={{
        ...evidence,
        runs: [
          {
            ...evidence.runs[0],
            artifactAttempt: 2,
            modelSnapshot: { agents: [{ ...actual, runId: 'run', artifactAttempt: 1 }] },
          },
        ],
      }}
    />
  )
  expect(screen.queryByTestId('workflow-agent-model-configuration')).toBeNull()
  view.unmount()
})
