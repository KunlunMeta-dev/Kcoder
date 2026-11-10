import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { AppServerStdioClient, waitForStdioChildClose } from './app-server-stdio.mjs';

// This worker runs only inside the parent RunContext's owned Windows Job.
// A separate stdin carries Native JSONL; the supervisor owns its control stdin.
assert.equal(process.platform, 'win32');
const [binary, workspace, receipt] = process.argv.slice(2);
for (const path of [binary, workspace, receipt]) assert.ok(isAbsolute(path));
const child = spawn(binary, ['--cwd', workspace, 'app-server'], {
  cwd: process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env,
});
child.stderr.pipe(process.stderr);
const client = new AppServerStdioClient('packaged-native-snapshot', child, { notificationHistoryLimit: 128 });
const rpc = async (method, params) => {
  const response = await client.request(method, params, 30000);
  assert.ok(!response.error, `${method}: ${response.error?.message}`);
  return response.result;
};
try {
  await rpc('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-snapshot-regression', version: '1' },
    capabilities: { experimental: { turnFileCaptureV1: true, turnReviewEvidenceV1: true } } });
  const { thread } = await rpc('thread/start', { cwd: workspace });
  await rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Create the owned snapshot fixture result.' }] });
  const terminal = await client.waitForNotification(frame => frame.method === 'turn/completed' && frame.params.threadId === thread.id, 60000);
  assert.equal(terminal.params.turn.status, 'completed');
  const capture = terminal.params.fileChangesCapture;
  assert.ok(['changed', 'partial'].includes(capture?.state), JSON.stringify(capture));
  assert.ok(capture.artifactId);
  const review = await rpc('device/execute', { threadId: thread.id, command_key: 'turn_file_changes_review',
    path: workspace, args: [capture.artifactId], timeout_seconds: 30, max_output_bytes: 1048576 });
  assert.equal(review.success, true, JSON.stringify(review));
  assert.equal(review.stdout?.success, true, JSON.stringify(review));
  assert.match(review.stdout.diff, /Owned Native long-path result/);
  assert.equal(await readFile(resolve(workspace, 'result.txt'), 'utf8'), 'Owned Native long-path result\n');
  await writeFile(receipt, JSON.stringify({ realNativeSnapshot: true, realDiffReadable: true, capture }), { flag: 'wx', mode: 0o600 });
} finally {
  child.stdin.end();
  try { await waitForStdioChildClose(child, 10000); }
  finally { client.closeReader(); }
}
