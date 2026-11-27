import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as guards from '../../apps/kcoder-studio/shared/generated/contractGuards.mjs';
import { isContract } from '../../apps/kcoder-studio/shared/generated/validator.mjs';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures.thread-workspace-index.json', import.meta.url)));
for (const [name, examples] of Object.entries(fixtures)) test(`persistent workspace contract ${name}`, () => {
  for (const example of examples.valid) {
    assert.equal(isContract(name, example.value), true, example.name);
    assert.equal(guards[`is${name}`](example.value), true, example.name);
  }
  for (const example of examples.invalid) assert.equal(isContract(name, example.value), false, example.name);
});
