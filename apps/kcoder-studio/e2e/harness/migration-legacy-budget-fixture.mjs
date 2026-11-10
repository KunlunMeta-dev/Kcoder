import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const parentId = value => typeof value === 'string' && /^mig-[a-f0-9]{32}$/.test(value);
/** Only the supplied stopped synthetic records become pre-budget fixtures; peers are retained. */
export function legacyBudgetDocuments({ parent = null, children, ledger }) {
  assert.ok(children.length > 0 && children.length <= 64);
  const next = structuredClone({ parent, children, ledger }), ids = children.map(child => child.view.jobId).sort();
  assert.ok(ids.every(uuid)); assert.equal(new Set(ids).size, ids.length);
  const owner = parent ? parent.jobId : ids[0];
  if (parent) {
    assert.ok(parentId(owner)); assert.equal(parent.status, 'completed');
    assert.ok(parent.batch.resourceLimits); assert.ok(parent.batch.planId);
    assert.deepEqual(parent.batch.actions.map(action => { assert.equal(action.status, 'committed'); assert.equal(action.action.kind, 'history'); return action.action.plan.historyJobId; }).sort(), ids);
    delete next.parent.batch.resourceLimits;
  } else assert.equal(ids.length, 1);
  const groups = new Set();
  for (const child of next.children) {
    assert.equal(child.view.stage, 'normalized'); assert.equal(child.view.cancelRequested, false);
    assert.equal(child.resourceBudget.owner, owner); assert.equal(child.resourceBudget.member, child.view.jobId);
    assert.deepEqual(child.resourceBudget.members, ids);
    const reference = child.resourceBudget.reference, group = ledger.resource_groups[reference.group];
    assert.ok(group); assert.deepEqual(group.reference, reference); assert.deepEqual(group.members, ids);
    groups.add(reference.group); child.version = 3; delete child.resourceBudget;
  }
  assert.equal(groups.size, 1);
  for (const group of groups) delete next.ledger.resource_groups[group];
  for (const archive of Object.values(next.ledger.archives)) if (groups.has(archive.resource_budget?.group)) delete archive.resource_budget;
  return next;
}
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.nlink === b.nlink && a.uid === b.uid;
async function heldFile(path, maximum) {
  const file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const identity = await file.stat();
    assert.ok(identity.isFile() && identity.nlink === 1 && identity.uid === process.getuid() && (identity.mode & 0o077) === 0 && identity.size <= maximum);
    assert.ok(same(identity, await lstat(path)));
    const bytes = await file.readFile(); assert.ok(bytes.length <= maximum);
    return { path, file, identity, value: JSON.parse(bytes), async verify() { assert.ok(same(identity, await lstat(path)) && same(identity, await file.stat())); } };
  } catch (error) { await file.close(); throw error; }
}
/** This harness-only conversion requires an already stopped original owner inside this run. */
export async function makeOwnedLegacyBudgetFixture(context, profile, { parent = null, children }, stopped) {
  assert.equal(process.platform, 'linux', 'this GUI fixture has Linux-only file identity evidence');
  const root = await realpath(context.stateDir), directory = await realpath(profile), suffix = relative(root, directory);
  assert.ok(suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`));
  const stat = await lstat(directory); assert.ok(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
  const directories = [];
  for (const suffix of ['migrations', 'migrations/history', 'external-history', 'external-history/managed-v2']) {
    const path = resolve(directory, suffix), identity = await lstat(path);
    assert.ok(identity.isDirectory() && !identity.isSymbolicLink() && identity.uid === process.getuid() && (identity.mode & 0o077) === 0 && await realpath(path) === path);
    directories.push({ path, identity });
  }
  assert.ok(children.length > 0 && children.every(uuid) && new Set(children).size === children.length && (!parent || parentId(parent)));
  const held = [], acquire = async (path, max) => { const value = await heldFile(path, max); held.push(value); return value; };
  try {
    assert.equal(await stopped(), true);
    const parentFile = parent ? await acquire(resolve(directory, 'migrations', `${parent}.json`), 16 * 1024 ** 2) : null;
    const childFiles = [], births = [];
    for (const id of children) {
      const child = await acquire(resolve(directory, 'migrations/history', `${id}.json`), 128 * 1024);
      assert.equal(child.value.view.jobId, id); childFiles.push(child);
      const birth = await acquire(resolve(directory, 'migrations/history', `${id}.resource.birth`), 8192);
      assert.equal(birth.value.jobId, id); assert.equal(birth.value.resourceOwner, parent ?? id);
      assert.deepEqual(birth.value.outcome, { phase: 'bound', reference: child.value.resourceBudget.reference }); births.push(birth);
    }
    const ledger = await acquire(resolve(directory, 'external-history/managed-v2/lifecycle.json'), 16 * 1024 ** 2);
    const next = legacyBudgetDocuments({ parent: parentFile?.value ?? null, children: childFiles.map(file => file.value), ledger: ledger.value });
    assert.equal(await stopped(), true);
    for (const item of directories) assert.ok(same(item.identity, await lstat(item.path)));
    for (const file of held) await file.verify();
    const updates = [...(parentFile ? [[parentFile, next.parent]] : []), ...childFiles.map((file, index) => [file, next.children[index]]), [ledger, next.ledger]];
    for (const [file, value] of updates) { const bytes = Buffer.from(JSON.stringify(value)); await file.verify(); await file.file.truncate(0); assert.equal((await file.file.write(bytes, 0, bytes.length, 0)).bytesWritten, bytes.length); await file.file.sync(); }
    for (const birth of births) { await birth.verify(); await unlink(birth.path); }
    return { parent, children: [...children], syntheticLegacyVersion: 3, stoppedOwnerVerified: true };
  } finally { for (const file of held) await file.file.close(); }
}
