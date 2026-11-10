import { expect, it } from 'vitest'
import examples from '../../../shared/generated/examples.migration-source-credentials.json'
import type { MigrationSourceCredentialCandidatesParams, MigrationSourceCredentialCandidatesResult } from '../../../shared/generated/contracts'
import { selectPrivateCredential } from '../../../shared/migrationPrivateCredentialSelections'

const input = examples.MigrationSourceCredentialCandidatesParams.find(row => row.name === 'original_saved_plan_selector')!.value as MigrationSourceCredentialCandidatesParams
const page = examples.MigrationSourceCredentialCandidatesResult.find(row => row.name === 'saved_plan_exact_entry_mapping')!.value as MigrationSourceCredentialCandidatesResult

it('selects source fields but derives the destination only from the saved plan mapping', () => {
  expect(selectPrivateCredential(input, page, 'owned-item', { kind: 'mcp', fieldIndices: [0] })).toEqual({
    kind: 'mcp', sourceName: 'notes', targetName: 'renamed-notes', definitionSha256: 'c'.repeat(64), fields: [{ kind: 'environment', name: 'TOKEN' }],
  })
})

it('refuses unplanned, peer-plan and issue-bearing candidates', () => {
  const choice = { kind: 'mcp' as const, fieldIndices: [0] }
  expect(selectPrivateCredential({ ...input, jobId: undefined, expectedPlanId: undefined }, page, 'owned-item', choice)).toBeNull()
  expect(selectPrivateCredential({ ...input, expectedPlanId: 'peer-plan' }, page, 'owned-item', choice)).toBeNull()
  expect(selectPrivateCredential(input, { ...page, items: [{ ...page.items[0], issueCode: 'private_credentials_selector_unavailable' }] }, 'owned-item', choice)).toBeNull()
  expect(selectPrivateCredential(input, { ...page, items: [{ ...page.items[0], targets: [] }] }, 'owned-item', choice)).toBeNull()
})

it('requires explicit unique source-field indexes and cannot invent another field or tool kind', () => {
  for (const fieldIndices of [[], [1], [-1], [0, 0], [0.5]]) {
    expect(selectPrivateCredential(input, page, 'owned-item', { kind: 'mcp', fieldIndices })).toBeNull()
  }
  expect(selectPrivateCredential(input, page, 'owned-item', { kind: 'provider', selectorIndex: 0 })).toBeNull()
  expect(selectPrivateCredential(input, page, 'peer-item', { kind: 'mcp', fieldIndices: [0] })).toBeNull()
})

it('keeps a provider selector bound to the original source while preserving its actual planned destination', () => {
  const provider: MigrationSourceCredentialCandidatesResult = { ...page, items: [{ kind: 'provider', itemId: 'owned-provider', sourceName: 'source-provider',
    endpoint: 'https://source.invalid', apiFormat: 'openai_chat_completions', selectors: [{ kind: 'environment', variable: 'OWNED_KEY' }],
    sourceVerificationRequired: true, targets: [{ kind: 'provider', batchItemId: 'owned-target-item', targetName: 'planned-provider',
      endpoint: 'https://planned.invalid', apiFormat: 'openai_chat_completions' }] }] }
  expect(selectPrivateCredential(input, provider, 'owned-provider', { kind: 'provider', selectorIndex: 0 })).toEqual({
    kind: 'provider', sourceName: 'source-provider', selector: { kind: 'environment', variable: 'OWNED_KEY' },
    targetName: 'planned-provider', endpoint: 'https://planned.invalid', apiFormat: 'openai_chat_completions',
  })
  expect(selectPrivateCredential(input, provider, 'owned-provider', { kind: 'provider', selectorIndex: 1 })).toBeNull()
})
