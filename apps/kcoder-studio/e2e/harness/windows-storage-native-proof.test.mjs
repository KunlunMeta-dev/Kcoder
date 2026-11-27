import assert from 'node:assert/strict';
import test from 'node:test';
import { assertVhdImageIdentity, vhdReadyEvent, validateStorageLibtestOutput } from './windows-storage-native-proof.mjs';

test('storage NativeFS proof rejects zero execution and ignored-only success', () => {
  const summary = (passed, failed = 0, ignored = 0) =>
    `test result: ok. ${passed} passed; ${failed} failed; ${ignored} ignored; 0 measured; 1297 filtered out; finished in 0.00s\n`;
  const exact = ['storage::tests::original', '--exact', '--nocapture'];
  assert.doesNotThrow(() => validateStorageLibtestOutput(exact, summary(1), 0));
  for (const output of [summary(0), summary(0, 0, 1), summary(1, 1), summary(2), 'test execution was not observed'])
    assert.throws(() => validateStorageLibtestOutput(exact, output, 0));
  assert.throws(() => validateStorageLibtestOutput(exact, summary(1), 101));
  assert.doesNotThrow(() => validateStorageLibtestOutput(['storage::tests::'], summary(2), 0));
});

test('storage NativeFS listing must actually contain the selected exact test', () => {
  const args = ['storage::tests::original', '--exact', '--list'];
  assert.doesNotThrow(() => validateStorageLibtestOutput(args, 'storage::tests::original: test\r\n\r\n1 test, 0 benchmarks\r\n', 0));
  for (const output of ['0 tests, 0 benchmarks\n', 'storage::tests::peer: test\n',
    'storage::tests::original: test\nstorage::tests::peer: test\n'])
    assert.throws(() => validateStorageLibtestOutput(args, output, 0));
});

test('owned VHD READY parser accepts a bare fixture JSON frame', () => {
  assert.deepEqual(vhdReadyEvent('{"event":"READY","owner":"owned"}'), { event: 'READY', owner: 'owned' });
});

test('owned VHD READY parser accepts the exact libtest fixture prefix', () => {
  assert.deepEqual(vhdReadyEvent('test owned_vhdx_fixture ... {"event":"READY","owner":"owned"}'),
    { event: 'READY', owner: 'owned' });
});

test('owned VHD READY parser rejects unrelated prefixes and events', () => {
  assert.equal(vhdReadyEvent('test other_fixture ... {"event":"READY"}'), null);
  assert.equal(vhdReadyEvent('diagnostic {"event":"READY"}'), null);
  assert.equal(vhdReadyEvent('{"event":"STOPPED"}'), null);
});

test('owned VHD metadata guard preserves exact bigint file and actual held-volume identity', () => {
  const ready = { image_identity: { file_index_high: 0xf1234567, file_index_low: 0x89abcdef, volume_serial: 2455810732 } };
  const stats = () => ({ ino: (0xf1234567n << 32n) + 0x89abcdefn, dev: 2455810732n, nlink: 1n,
    isFile: () => true, isSymbolicLink: () => false });
  const named = { ...stats(), dev: 0n }, held = stats();
  assert.doesNotThrow(() => assertVhdImageIdentity(ready, named, held));
  for (const [snapshot, field, value] of [['held', 'dev', 0n], ['held', 'dev', 1n], ['held', 'ino', held.ino + 1n],
    ['named', 'ino', named.ino + 1n], ['held', 'nlink', 2n], ['named', 'nlink', 2n],
    ['named', 'isSymbolicLink', () => true], ['held', 'isFile', () => false]]) {
    const nextNamed = { ...named }, nextHeld = { ...held };
    (snapshot === 'held' ? nextHeld : nextNamed)[field] = value;
    assert.throws(() => assertVhdImageIdentity(ready, nextNamed, nextHeld));
  }
});
