import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('sealed verification has a finite native roster bound to existing Rust tests', async () => {
  const roster = JSON.parse(await readFile(new URL('../fixtures/sealed-verify-native-roster.json', import.meta.url)));
  assert.equal(roster.externalRequests, 0);
  assert.equal(roster.expectedIgnored, 0);
  for (const entry of roster.components) {
    const source = await readFile(new URL(`../../../../${entry.source}`, import.meta.url), 'utf8');
    const names = [...source.matchAll(/(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)]
      .map(match => `${entry.filter}${match[1]}`).sort();
    assert.equal(new Set(entry.names).size, entry.names.length);
    assert.deepEqual([...entry.names].sort(), names);
    assert.ok(entry.names.every(name => name.startsWith(entry.filter)));
    assert.ok(!source.includes('#[ignore'));
  }
});
