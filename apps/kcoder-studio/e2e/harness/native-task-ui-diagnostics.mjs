import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { originalSystemdCarrier } from './native-systemd-carrier.mjs';
import { waitForStdioChildClose } from './app-server-stdio.mjs';

export function parseTaskUiDiagnostics(text) {
  const events = [];
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  for (const line of text.split('\n')) {
    if (events.length >= 32) break;
    const start = line.indexOf('{');
    if (start < 0) continue;
    try {
      const value = JSON.parse(line.slice(start));
      if (value.event === 'native_task_ui_transport_failed' &&
          ['management_stream', 'task_attach', 'task_stream', 'core_ui_stream', 'core_ui_worker'].includes(value.stage) &&
          Array.isArray(value.reasonSha256) && value.reasonSha256.length <= 6 && value.reasonSha256.every(digest))
        events.push({ event: value.event, stage: value.stage, reasonSha256: value.reasonSha256 });
      if (value.event === 'native_task_ui_notification_rejected' && digest(value.methodSha256) && typeof value.sameThread === 'boolean')
        events.push({ event: value.event, methodSha256: value.methodSha256, sameThread: value.sameThread });
    } catch {}
  }
  return events;
}

export async function collectTaskUiDiagnostics(context, fixture, carrier) {
  assert.equal((await originalSystemdCarrier(fixture)).path, carrier.path);
  const label = 'task-socket-owned-unit-diagnostics';
  const child = context.spawnOwned(label, process.execPath,
    [fileURLToPath(new URL('./native-task-ui-journal-worker.mjs', import.meta.url)), carrier.unit],
    { uid: fixture.uid, gid: fixture.gid, env: fixture.env, cwd: fixture.workspace });
  let text = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { if (text.length + chunk.length <= 256 * 1024) text += chunk; });
  try { const exit = await waitForStdioChildClose(child, 15_000, label); assert.equal(exit.code, 0); }
  finally { await context.stopOwned(label); }
  let client = '';
  try { client = await readFile(resolve(context.runRoot, 'logs/task-socket-independent-viewer.log'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = { core: JSON.parse(text), client: parseTaskUiDiagnostics(client) };
  await context.writeArtifactJson('native-task-ui-transport-diagnostics.json', result);
  return result;
}
