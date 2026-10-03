import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startSshFixture } from './ssh-fixture.mjs';
import { RunContext, repoRoot, waitFor } from './run-context.mjs';
import { materializeWorkspace } from './workspace-fixture.mjs';

test('synthetic account entry verifies credentials and routes the real CLI to separate profiles', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'account-entry-routing-only' });
  try {
    const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'account-entry' });
    const accounts = [];
    for (const [index, username] of ['alice', 'bob'].entries()) {
      const password = `synthetic-${username}`; context.registerSecret(password);
      const configDir = context.pathInState(username);
      await context.writeStateJson(`${username}/settings.json`, {
        active_provider: username, providers: { [username]: { api_format: 'openai_chat_completions',
          endpoint: 'http://127.0.0.1:1/v1', authentication: { mode: 'none' }, default_model: `${username}-model`,
          context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024 } },
      });
      accounts.push({ username, password, configDir, fixtureUid: 2000 + index,
        principalId: `0b6cfba4-5f61-4d17-9d92-3d60a1ef2f0${index}` });
    }
    const config = await context.writeStateJson('entry.json', { workspace, accounts, binary: resolve(repoRoot, 'target/debug/kcoder') });
    for (const username of ['alice', 'bob', 'invalid']) {
      const child = context.spawnOwned(`entry-${username}`, process.execPath,
        [resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/account-entry-fixture.mjs'), config], { stdin: 'pipe' });
      let buffer = ''; const frames = [];
      child.stdout.on('data', chunk => {
        buffer += chunk.toString();
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          frames.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
        }
      });
      child.stdin.write(JSON.stringify({ protocol: 'kcoder-account-v1', username, password: `synthetic-${username}` }) + '\n');
      const hello = await waitFor(() => frames.find(frame => frame.protocol === 'kcoder-account-v1'), 10000, 'account hello');
      assert.equal(hello.authenticated, username !== 'invalid');
      if (username !== 'invalid') {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-27', clientInfo: { name: 'account-fixture', version: '1' } } }) + '\n');
        assert.ok((await waitFor(() => frames.find(frame => frame.id === 1), 10000, 'real initialize')).result);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'runtime.models.list', params: {} }) + '\n');
        const result = await waitFor(() => frames.find(frame => frame.id === 2), 10000, 'scoped model catalog');
        assert.ok(JSON.stringify(result).includes(`${username}-model`));
        assert.ok(!JSON.stringify(result).includes(`${username === 'alice' ? 'bob' : 'alice'}-model`));
      }
      child.stdin.end();
      await context.stopOwned(`entry-${username}`);
    }
    await context.finish('passed', { scope: 'synthetic authentication boundary and real CLI profile routing; not Unix UID isolation' });
  } finally { if (!context.finished) await context.finish('failed', null, new Error('account fixture check failed')); }
});

test('SSH forced commands cannot escape the owned fixture directory', async () => {
  await assert.rejects(startSshFixture({ stateDir: '/owned' }, { forcedCommand: '/usr/bin/sh' }), /owned state path/);
  await assert.rejects(startSshFixture({ stateDir: '/owned' }, { forcedCommand: '/owned/../usr/bin/sh' }), /owned state path/);
  await assert.rejects(startSshFixture({ stateDir: '/owned' }, { forcedCommand: '/owned/entry\nBadConfig yes' }), /owned state path/);
});
