import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayRequestOutcome, gatewayRequestTimeoutMs } from '../shared/gatewayRequestDeadline.js';

test('batch observation is read-only while starting a worker retains an unknown mutation outcome', () => {
  assert.equal(gatewayRequestOutcome('migration/batch/read'), 'readOnly');
  assert.equal(gatewayRequestOutcome('migration/batch/run'), 'unknown');
  assert.equal(gatewayRequestTimeoutMs('migration/batch/read'), 30_000);
  for (const method of ['migration/batch/read/run', 'migration/batch/reading', 'custom/migration/batch/read'])
    assert.equal(gatewayRequestOutcome(method), 'unknown');
});

test('history search is an exact read-only method with a bounded deadline', () => {
  assert.equal(gatewayRequestOutcome('migration/history/search'), 'readOnly');
  assert.equal(gatewayRequestTimeoutMs('migration/history/search'), 30_000);
  assert.equal(gatewayRequestTimeoutMs('migration/history/search', 1500), 1500);
  for (const method of ['migration/history/search/run', 'migration/history/search/cancel', 'migration/history/searching', 'migration/history/branch/search', 'custom/migration/history/search']) {
    assert.equal(gatewayRequestOutcome(method), 'unknown', method);
    assert.equal(gatewayRequestTimeoutMs(method), 120_000, method);
  }
  for (const override of [0, -1, 3_600_001, Infinity]) {
    assert.throws(() => gatewayRequestTimeoutMs('migration/history/search', override), RangeError);
  }
});

test('migration reads can time out as reads, while every mutation retains unknown-outcome semantics', () => {
  assert.equal(gatewayRequestOutcome('migration/history/continuation/read'),'readOnly');
  assert.equal(gatewayRequestOutcome('migration/history/continuation/source'),'readOnly');
  for(const operation of ['create','run','resume','cancel'])assert.equal(gatewayRequestOutcome(`migration/history/continuation/${operation}`),'unknown');
  for (const method of ['migration/history/tool-attachments/read','migration/history/tool-attachments/items','migration/history/tool-attachments/chunk','migration/history/attachment/read', 'migration/history/attachment/chunk', 'migration/history/branch/tools/read', 'migration/history/branch/tools/page', 'migration/history/branch/read', 'migration/history/branch/page', 'migration/history/branch/blocks', 'migration/history/branch/text', 'migration/history/transcript', 'migration/history/blocks', 'migration/history/text', 'migration/history/discover', 'migration/history/sources', 'migration/history/read', 'migration/history/jobs', 'migration/batch/mcp/credential/read', 'migration/mcp/credential/read', 'migration/discover', 'migration/read', 'migration/items', 'migration/asset/preview', 'migration/jobs/list', 'migration/batch/item/plan']) {
    assert.equal(gatewayRequestOutcome(method), 'readOnly', method);
  }
  for (const method of ['migration/history/tool-attachments/run','migration/history/tool-attachments/resume','migration/history/tool-attachments/cancel','migration/history/attachment/run', 'migration/history/attachment/resume', 'migration/history/attachment/cancel', 'migration/history/branch/tools/run', 'migration/history/branch/tools/resume', 'migration/history/branch/tools/cancel', 'migration/history/branch/prepare', 'migration/history/branch/run', 'migration/history/branch/cancel', 'migration/history/branch/resume', 'migration/history/create', 'migration/history/run', 'migration/history/cancel', 'migration/history/resume', 'migration/mcp/credential/plan', 'migration/mcp/credential/apply', 'migration/mcp/credential/undo', 'migration/scan', 'migration/provider/plan', 'migration/provider/apply', 'migration/provider/rollback', 'migration/credential/plan', 'migration/credential/apply', 'migration/credential/undo', 'migration/asset/plan', 'migration/asset/apply', 'migration/asset/rollback', 'migration/batch/scan', 'migration/batch/plan', 'migration/batch/apply', 'migration/batch/rollback', 'migration/cancel', 'migration/custom/read']) {
    assert.equal(gatewayRequestOutcome(method), 'unknown', method);
  }
});

test('undo observations keep separate deadlines and writes retain unknown-outcome semantics',()=>{
  for(const method of ['lookup','preview','read'])assert.equal(gatewayRequestOutcome(`migration/history/undo/${method}`),'readOnly');
  for(const method of ['create','run','cancel','preview/run','read-all'])assert.equal(gatewayRequestOutcome(`migration/history/undo/${method}`),'unknown');
  assert.equal(gatewayRequestTimeoutMs('migration/history/undo/preview'),60_000);
})

test('only the exact interpretation preview is read-only; creation and lookalikes remain unknown', () => {
  assert.equal(gatewayRequestOutcome('migration/history/reinterpret/preview'), 'readOnly');
  assert.equal(gatewayRequestTimeoutMs('migration/history/reinterpret/preview'), 30_000);
  for (const method of ['create', 'preview/run', 'preview-all', 'read']) {
    assert.equal(gatewayRequestOutcome(`migration/history/reinterpret/${method}`), 'unknown');
  }
});

test('only explicit local attachment observations are safe to retry after a deadline', () => {
  for (const name of ['read', 'list', 'chunk'])
    assert.equal(gatewayRequestOutcome(`migration/history/local-attachment/${name}`), 'readOnly');
  for (const name of ['prepare', 'begin', 'part', 'finish', 'run', 'resume', 'cancel', 'read/all'])
    assert.equal(gatewayRequestOutcome(`migration/history/local-attachment/${name}`), 'unknown');
});

test('local plugin migration only retries exact observations and keeps installation outcomes unknown', () => {
  for (const name of ['discover', 'read', 'list']) {
    assert.equal(gatewayRequestOutcome(`migration/plugin/${name}`), 'readOnly');
    assert.equal(gatewayRequestTimeoutMs(`migration/plugin/${name}`), 30_000);
  }
  for (const name of ['plan', 'capture', 'apply', 'undo', 'cancel', 'resume', 'read/all', 'listing'])
    assert.equal(gatewayRequestOutcome(`migration/plugin/${name}`), 'unknown');
});

test('static configuration layer reports are exact bounded read-only observations', () => {
  assert.equal(gatewayRequestOutcome('migration/configuration/layers'), 'readOnly');
  assert.equal(gatewayRequestTimeoutMs('migration/configuration/layers'), 30_000);
  for (const suffix of ['/run', '/reset', '-all'])
    assert.equal(gatewayRequestOutcome(`migration/configuration/layers${suffix}`), 'unknown');
});


test('Codex layer selection/report stay exact read-only operations with bounded request deadlines', () => {
  for (const operation of ['select', 'read']) {
    const method = `migration/codex/layers/${operation}`;
    assert.equal(gatewayRequestOutcome(method), 'readOnly');
    assert.equal(gatewayRequestTimeoutMs(method), 30_000);
    for (const suffix of ['/run', '-all', '/reset']) assert.equal(gatewayRequestOutcome(method + suffix), 'unknown');
  }
});


test('Native source binding description is an exact readonly observation', () => {
  assert.equal(gatewayRequestOutcome('migration/source/bindings'), 'readOnly');
  for (const suffix of ['/write', '-all', '/reset']) assert.equal(gatewayRequestOutcome('migration/source/bindings' + suffix), 'unknown');
});


test('imported memory discovery and observation are readonly, while CAS activation is mutating', () => {
  for (const operation of ['discover', 'sources', 'list', 'read', 'control/read']) {
    assert.equal(gatewayRequestOutcome('migration/memory/' + operation), 'readOnly');
    assert.equal(gatewayRequestOutcome('migration/memory/' + operation + '/reset'), 'unknown');
  }
  assert.equal(gatewayRequestOutcome('migration/memory/control'), 'unknown');
});


test('source upload reads are bounded observations and upload controls keep unknown outcomes', () => {
  for (const name of ['read', 'files']) {
    assert.equal(gatewayRequestOutcome(`migration/source/upload/${name}`), 'readOnly');
    assert.equal(gatewayRequestTimeoutMs(`migration/source/upload/${name}`), 30_000);
  }
  for (const name of ['prepare', 'part', 'finish', 'cancel', 'resume', 'read/all', 'files/reset'])
    assert.equal(gatewayRequestOutcome(`migration/source/upload/${name}`), 'unknown');
});


test('uploaded product observation does not turn preparation or source selection into a retryable read', () => {
  assert.equal(gatewayRequestOutcome('migration/source/upload/product/read'), 'readOnly');
  for (const name of ['run', 'resume', 'cancel', 'read/all'])
    assert.equal(gatewayRequestOutcome(`migration/source/upload/product/${name}`), 'unknown');
  assert.equal(gatewayRequestOutcome('migration/source/upload/select'), 'unknown');
});


test('only exact passive definition observations are readOnly', () => {
  for (const operation of ['discover','report','body']) {
    assert.equal(gatewayRequestOutcome('migration/definitions/' + operation), 'readOnly');
    assert.equal(gatewayRequestOutcome('migration/definitions/' + operation + '/execute'), 'unknown');
  }
  assert.equal(gatewayRequestOutcome('migration/definitions/activate'), 'unknown');
});
