import assert from 'node:assert/strict';

const handles = new WeakMap();
export const containerLabel = 'kcoder.test.peer-uid-container-owner';
export function containerFacts(actual) {
  return { id: actual.Id, image: actual.Image, owner: actual.Config.Labels[containerLabel], network: actual.HostConfig.NetworkMode,
    privileged: actual.HostConfig.Privileged, pidMode: actual.HostConfig.PidMode ?? '', running: actual.State.Running, mounts: actual.Mounts };
}

export function assertOriginalPeerUidContainer(expected, actual) {
  assert.match(expected.id, /^[a-f0-9]{64}$/); assert.match(expected.owner, /^[a-f0-9-]{36}$/);
  assert.equal(actual.id, expected.id, 'Original UID container identity changed');
  assert.equal(actual.image, expected.image, 'Original UID container image changed');
  assert.equal(actual.owner, expected.owner, 'Original UID container owner changed');
  assert.equal(actual.network, 'none'); assert.equal(actual.privileged, false); assert.equal(actual.pidMode, '');
  const mounts = actual.mounts.map(row => ({ source: row.Source, destination: row.Destination, writable: row.RW })).sort((a, b) => a.destination.localeCompare(b.destination));
  assert.deepEqual(mounts, [...expected.mounts].sort((a, b) => a.destination.localeCompare(b.destination)), 'Original UID container mounts changed');
}

export async function capturePeerUidContainer(context, expected, execute) {
  const actual = containerFacts(JSON.parse(await execute(['inspect', expected.id]))[0]);
  assertOriginalPeerUidContainer(expected, actual);
  const handle = Object.freeze({}); handles.set(handle, { context, expected: structuredClone(expected), execute, removed: false });
  return handle;
}

export async function removeStoppedPeerUidContainer(context, handle) {
  const entry = handles.get(handle); assert.ok(entry && entry.context === context, 'Unowned or forged UID container handle');
  if (entry.removed) return;
  const actual = containerFacts(JSON.parse(await entry.execute(['inspect', entry.expected.id]))[0]);
  assertOriginalPeerUidContainer(entry.expected, actual);
  assert.equal(actual.running, false, 'Retain original UID container until its processes are stopped');
  await entry.execute(['rm', entry.expected.id], { label: 'remove-original-container' }); entry.removed = true;
}

export async function stopOriginalPeerUidContainer(context, handle) {
  const entry = handles.get(handle); assert.ok(entry && entry.context === context, 'Unowned or forged UID container handle');
  const actual = containerFacts(JSON.parse(await entry.execute(['inspect', entry.expected.id]))[0]);
  assertOriginalPeerUidContainer(entry.expected, actual);
  if (actual.running) await entry.execute(['stop', '--time', '10', entry.expected.id], { label: 'stop-original-container' });
}
