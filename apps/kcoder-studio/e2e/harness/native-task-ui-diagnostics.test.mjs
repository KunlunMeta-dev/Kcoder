import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTaskUiDiagnostics } from './native-task-ui-diagnostics.mjs';
test('task UI diagnostics retain finite failure hashes without arbitrary journal data', () => {
  const digest = 'a'.repeat(64);
  const values = [
    { event: 'other', secret: 'do-not-copy' },
    { event: 'native_task_ui_transport_failed', stage: 'task_stream', reasonSha256: [digest], secret: 'do-not-copy' },
    { event: 'native_task_ui_transport_failed', stage: 'task_attach', reasonSha256: [digest], secret: 'do-not-copy' },
    { event: 'native_task_ui_transport_failed', stage: 'unknown', reasonSha256: [digest] },
    { event: 'native_task_ui_transport_failed', stage: 'task_stream', reasonSha256: ['do-not-copy'] },
    { event: 'native_task_ui_notification_rejected', methodSha256: digest, sameThread: true, body: 'do-not-copy' },
  ];
  const result = parseTaskUiDiagnostics(values.map(value => '[native] ' + JSON.stringify(value)).join('\n'));
  assert.deepEqual(result, [
    { event: 'native_task_ui_transport_failed', stage: 'task_stream', reasonSha256: [digest] },
    { event: 'native_task_ui_transport_failed', stage: 'task_attach', reasonSha256: [digest] },
    { event: 'native_task_ui_notification_rejected', methodSha256: digest, sameThread: true },
  ]);
  assert.equal(JSON.stringify(result).includes('do-not-copy'), false);
});
test('task UI journal evidence has a fixed event bound', () => {
  const row = JSON.stringify({ event: 'native_task_ui_transport_failed', stage: 'core_ui_stream', reasonSha256: ['0'.repeat(64)] });
  assert.equal(parseTaskUiDiagnostics((row + '\n').repeat(100)).length, 32);
});
