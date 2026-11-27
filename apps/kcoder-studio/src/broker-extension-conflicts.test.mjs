import test from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_EXPERIMENTAL_CHOICES, EXTENSIONS_INVENTORY_CAPABILITY, backendInitializeParams, projectClientResponse } from './broker-initialize-capabilities.js';
import { gatewayRequestOutcome } from '../shared/gatewayRequestDeadline.js';

const response = () => ({ jsonrpc: '2.0', id: 7, result: { generation: 1, plugin: { id: 'lark@trae' }, extensionConflicts: { entries: [], conflicts: [] } } });

test('shared backend opts into the extension inventory for every client choice', () => {
  assert.ok(CLIENT_EXPERIMENTAL_CHOICES.includes(EXTENSIONS_INVENTORY_CAPABILITY));
  const params = backendInitializeParams({ protocolVersion: '2026-07-27', clientInfo: { name: 'mobile', version: '1' } }, false);
  assert.equal(params.capabilities.experimental[EXTENSIONS_INVENTORY_CAPABILITY], true);
});

test('plugin conflict previews reach only clients that declared extensionsInventoryV1', () => {
  for (const method of ['plugin/install', 'plugin/read']) {
    const legacy = projectClientResponse(response(), { method, client: {} });
    assert.equal(legacy.result.extensionConflicts, undefined);
    assert.equal(legacy.result.plugin.id, 'lark@trae');
    const opted = projectClientResponse(response(), { method, client: { [EXTENSIONS_INVENTORY_CAPABILITY]: true } });
    assert.deepEqual(opted.result.extensionConflicts, { entries: [], conflicts: [] });
  }
  const other = projectClientResponse({ jsonrpc: '2.0', id: 1, result: { extensionConflicts: 1 } }, { method: 'plugin/list', client: {} });
  assert.equal(other.result.extensionConflicts, 1);
});

test('inventory and conflict preview are read-only Gateway methods; preference updates are not', () => {
  assert.equal(gatewayRequestOutcome('extensions/inventory'), 'readOnly');
  assert.equal(gatewayRequestOutcome('extensions/conflicts/preview'), 'readOnly');
  assert.equal(gatewayRequestOutcome('extensions/skillPreference/update'), 'unknown');
});
