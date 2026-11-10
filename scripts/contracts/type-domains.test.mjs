import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTypeDomains, schemaTypeReferences } from './type-domains.mjs';

test('type partitions preserve all public names and make every cross-domain import type-only', () => {
  const types = new Map([['MigrationSourceNullable_for_Boolean', 'boolean | null'], ['MigrationSourceCredentialConsent', '{ apiKeys: boolean }'], ['ModelConfigurationSummary', 'string'],
    ['MigrationSourceCredentialPrepareResult', 'ModelConfigurationSummary']]);
  const refs = new Map([['MigrationSourceCredentialPrepareResult', new Set(['ModelConfigurationSummary'])]]);
  const generated = generateTypeDomains(types, refs, '// generated\n');
  assert.match(generated.files['contracts.migration-source-credentials.ts'], /^\/\/ generated\nimport type \{ ModelConfigurationSummary \} from/);
  assert.match(generated.files['contracts.migration-source-credentials.ts'], /export type MigrationSourceCredentialConsent = \{ apiKeys: boolean \};/);
  assert.match(generated.facade, /export type \* from '.\/contracts.migration-source-credentials.js';/);
  assert.equal(Object.values(generated.files).join('').includes('import {'), false);
  assert.deepEqual(generateTypeDomains(new Map([...types].reverse()), refs, '// generated\n'), generated);
  assert.throws(() => generateTypeDomains(types, new Map([['MigrationSourceCredentialConsent', new Set(['Unregistered'])]])), /Unregistered/);
});

test('a declaration imports only references in its own body, including nullable and recursive branches', () => {
  assert.deepEqual([...schemaTypeReferences({ properties: { one: { $ref: '#/definitions/One' },
    two: { anyOf: [{ type: 'null' }, { items: { $ref: '#/definitions/Two' } }] } },
    definitions: { Unused: { $ref: '#/definitions/UnusedDependency' } } })].sort(), ['One', 'Two']);
});

test('legacy domain facades retain task and collaboration types without runtime imports', () => {
  const generated = generateTypeDomains(new Map([
    ['AgentStreamSubscribeParams', 'string'],
    ['BrowserAccountProfile', 'string'],
    ['WorkflowCollaborationPlan', 'string'],
    ['IntegrationTaskCapabilityScopeSnapshot', 'string'],
    ['TaskWorkspaceSnapshot', 'string'],
    ['IntegrationModelResolutionResult', 'string'],
    ['AutomationSubscriptionDraft', 'string'],
  ]), new Map());
  assert.match(generated.files['contracts.core.ts'], /export type \* from '.\/contracts.workflow-collaboration.js';/);
  assert.match(generated.files['contracts.core.ts'], /export type \* from '.\/contracts.agents.js';/);
  assert.match(generated.files['contracts.core.ts'], /export type \* from '.\/contracts.browser-profiles.js';/);
  assert.match(generated.files['contracts.browser-profiles.ts'], /export type BrowserAccountProfile = string;/);
  assert.match(generated.files['contracts.agents.ts'], /export type AgentStreamSubscribeParams = string;/);
  assert.match(generated.files['contracts.integrations-core.ts'], /export type \* from '.\/contracts.integrations-tasks.js';/);
  assert.match(generated.files['contracts.integrations-core.ts'], /export type \* from '.\/contracts.integrations-models.js';/);
  assert.match(generated.files['contracts.integrations-models.ts'], /export type IntegrationModelResolutionResult = string;/);
  assert.match(generated.files['contracts.integrations-knowledge-automation.ts'], /export type \* from '.\/contracts.integrations-knowledge-subscriptions.js';/);
  assert.match(generated.files['contracts.integrations-knowledge-subscriptions.ts'], /export type AutomationSubscriptionDraft = string;/);
  assert.match(generated.files['contracts.workflow-collaboration.ts'], /export type WorkflowCollaborationPlan = string;/);
  assert.match(generated.files['contracts.integrations-tasks.ts'], /export type TaskWorkspaceSnapshot = string;/);
  assert.match(generated.files['contracts.integrations-tasks.ts'], /export type \* from '.\/contracts.integrations-task-capability-scope.js';/);
  assert.match(generated.files['contracts.integrations-task-capability-scope.ts'], /export type IntegrationTaskCapabilityScopeSnapshot = string;/);
  assert.equal(Object.values(generated.files).join('').includes('import {'), false);
});
