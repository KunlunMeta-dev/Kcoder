import assert from 'node:assert/strict';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { waitFor } from './run-context.mjs';

/** Drive one actual bounded CLI process; RunContext retains exact ownership and cleanup. */
export async function runMigrationGuideDialog({ context, binary, gateway, token, workspace, record,
  label, args = [], localArgs, answer, observe = () => {}, staleAnswer = false }) {
  const command = localArgs ? ['migrate', 'configure', ...localArgs, ...args, '--jsonl'] :
    ['migrate', 'transfer', '--gateway', gateway, '--access-token-env', 'OWNED_GUIDE_ACCESS', 'guide', '--record', record, ...args, '--jsonl'];
  const child = context.spawnOwned(label, binary, command, {
    cwd: workspace, stdin: 'pipe', env: context.isolatedEnvironment(token ? { OWNED_GUIDE_ACCESS: token } : {}),
  });
  const decoder = new StringDecoder('utf8'); let buffer = '', failure, pending = Promise.resolve(), sent = false;
  const fail = error => {
    failure ??= error;
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
  };
  child.stdin.on('error', fail);
  child.stdout.on('data', bytes => {
    buffer += decoder.write(bytes); assert.ok(Buffer.byteLength(buffer) <= 2 * 1024 * 1024);
    let next;
    while ((next = buffer.indexOf('\n')) >= 0) {
      const raw = buffer.slice(0, next); buffer = buffer.slice(next + 1);
      pending = pending.then(async () => {
        if (failure) return;
        if (token) assert.ok(!raw.includes(token));
        const frame = JSON.parse(raw); await observe(frame, raw);
        if (frame.type !== 'prompt') return;
        if (staleAnswer && !sent) { child.stdin.write(`${JSON.stringify({ id: randomUUID(), value: 'IMPORT' })}\n`); sent = true; }
        const value = await answer(frame);
        if (failure) return;
        child.stdin.write(`${JSON.stringify({ id: frame.id, value })}\n`);
      }).catch(fail);
    }
  });
  await waitFor(() => child.exitCode !== null, 120000, label, 20, context.abortSignal);
  await pending; if (failure) throw failure;
  assert.equal(child.exitCode, 0, `inspect ${label}.log`); assert.equal(buffer.trim(), '');
}
