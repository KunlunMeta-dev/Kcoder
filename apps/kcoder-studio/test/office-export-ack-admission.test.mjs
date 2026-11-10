import test from 'node:test';
import assert from 'node:assert/strict';
import { assertIntegrationAdmission, integrationCapability, projectIntegrationCapabilities } from '../src/integrations/core/admission.mjs';
import fixtures from '../../../scripts/contracts/fixtures.integrations-office-exports.json' with { type: 'json' };

const scope = { accountId: 'fixture-owner', targetId: 'fixture-target', workspaceId: 'fixture-workspace',
  identityGeneration: '1', targetRevision: '1' };
const capabilities = { integrationScopeV1: true, officeWorkspaceV1: true,
  automationTemplatesV1: true, officeExportAcknowledgementV1: true };
const client = { ...capabilities, initialized: true };
const message = () => ({ id: 1, method: 'integrations/artifact/acknowledgeExport', params: {
  contractVersion: 'parallel-v1', requestId: 'original-ack-request', operationId: 'original-ack-operation',
  scope, timeoutMs: 30000, payload: fixtures.OfficeExportAcknowledgementParams.valid[0].value,
} });

test('export acknowledgement is a separately opted-in original client mutation', () => {
  assert.equal(integrationCapability(message().method), 'officeExportAcknowledgementV1');
  assert.doesNotThrow(() => assertIntegrationAdmission(message(), client, capabilities, true));
  for (const key of Object.keys(capabilities)) {
    assert.throws(() => assertIntegrationAdmission(message(), { ...client, [key]: false }, capabilities, true));
    assert.throws(() => assertIntegrationAdmission(message(), client, { ...capabilities, [key]: false }, true));
    assert.equal(projectIntegrationCapabilities(capabilities, { ...client, [key]: false }).officeExportAcknowledgementV1, false);
  }
  const noId = message(); delete noId.id;
  assert.throws(() => assertIntegrationAdmission(noId, client, capabilities, true));
});

test('download assertions cannot replace the finite acknowledgement payload or original operation', () => {
  const forged = message(); forged.params.payload = { ...forged.params.payload, streamComplete: true };
  assert.throws(() => assertIntegrationAdmission(forged, client, capabilities, true));
  const missing = message(); delete missing.params.operationId;
  assert.throws(() => assertIntegrationAdmission(missing, client, capabilities, true));
});


test('ordinary byte receipts require their own capability without borrowing D consent', () => {
  const ordinary = message(); ordinary.params.payload = { ...ordinary.params.payload }; delete ordinary.params.payload.automationRunId;
  const caps = { integrationScopeV1: true, officeWorkspaceV1: true, officeExportReceiptV1: true };
  const peer = { ...caps, initialized: true };
  assert.doesNotThrow(() => assertIntegrationAdmission(ordinary, peer, caps, true));
  for (const key of Object.keys(caps)) {
    assert.throws(() => assertIntegrationAdmission(ordinary, { ...peer, [key]: false }, caps, true));
    assert.throws(() => assertIntegrationAdmission(ordinary, peer, { ...caps, [key]: false }, true));
  }
  assert.equal(projectIntegrationCapabilities(caps, peer).officeExportReceiptV1, true);
  const wrongD = message(); wrongD.params.payload.automationRunId = 'wrong-original-d-run';
  assert.throws(() => assertIntegrationAdmission(wrongD, peer, caps, true));
});


test('explicit bad D locators never downgrade to ordinary receipt capability', () => {
  const caps = { ...capabilities, officeExportReceiptV1: true };
  const peer = { ...caps, initialized: true };
  for (const invalid of [null, '', '   ', false, 1]) {
    const supplied = message(); supplied.params.payload = { ...supplied.params.payload, automationRunId: invalid };
    assert.throws(() => assertIntegrationAdmission(supplied, peer, caps, true));
  }
});
