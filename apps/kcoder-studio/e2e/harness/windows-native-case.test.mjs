import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { RunContext } from './run-context.mjs';
import { windowsNativeCaseContext } from './windows-native-case.mjs';

test('native cases preserve separate redacted evidence, state and owned labels in one run', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'native-case-scope', tier: 'unit', modelPolicy: 'no process, network or model' });
  const calls = [];
  context.spawnOwned = (...args) => calls.push(['spawn', ...args]);
  context.stopOwned = (...args) => calls.push(['stop', ...args]);
  context.registerSecret('synthetic-case-private-value');
  try {
    const first = windowsNativeCaseContext(context, 'first'), second = windowsNativeCaseContext(context, 'second');
    const left = await first.writeArtifactJson('result.json', { secret: 'synthetic-case-private-value' });
    const right = await second.writeArtifactJson('result.json', { exact: 'second' });
    assert.notEqual(left, right);
    assert.equal(left, context.pathInCase('windows-native', 'first', 'result.json'));
    assert.ok(!(await readFile(left, 'utf8')).includes('synthetic-case-private-value'));
    assert.equal(JSON.parse(await readFile(right, 'utf8')).exact, 'second');
    assert.notEqual(await first.writeStateJson('input.json', {}), await second.writeStateJson('input.json', {}));
    first.spawnOwned('transport', 'node', []); second.spawnOwned('transport', 'node', []); first.stopOwned('transport');
    assert.deepEqual(calls.map(value => value.slice(0, 2)), [['spawn', 'first-transport'], ['spawn', 'second-transport'], ['stop', 'first-transport']]);
    assert.throws(() => windowsNativeCaseContext(context, '../escape'));
    assert.throws(() => first.pathInArtifacts('../second/result.json'));
    await assert.rejects(first.writeArtifactJson('result.json', {}), { code: 'EEXIST' });
  } finally { await context.finish('passed', { scoped: true }); }
});
