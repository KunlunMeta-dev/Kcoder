import { join, resolve, win32 } from 'node:path';
import { privateRecoveryBase, verifyDirectory, writePrivate, readPrivate, removePrivate, syncDirectory, digest } from './windows-keyring-recovery-files.mjs';

const TTL = 60 * 60 * 1000;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sidPattern = /^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/;
const codes = new Set(['invalid', 'directory_changed', 'record_budget', 'file_permissions', 'file_changed', 'record_invalid',
  'requires_posix_owner', 'requires_external_private_temp', 'namespace_changed', 'owner_changed', 'proof_changed',
  'expired', 'sid_changed', 'cleanup_unconfirmed', 'retained_cleanup_unconfirmed', 'capacity']);
const fail = code => { throw Error('keyring_recovery_' + code); };
async function safe(callback) {
  try { return await callback(); } catch (error) {
    const code = typeof error?.message === 'string' ? error.message.replace(/^keyring_recovery_/, '') : '';
    // File/backend errors and assertion objects may contain arbitrary values; never retain their chains.
    throw Error('keyring_recovery_' + (codes.has(code) ? code : 'invalid'));
  }
}
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...names].sort());
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function binding(value) {
  if (!keys(value, ['owner', 'root', 'runRoot', 'target', 'username']) || !uuid.test(value.owner) ||
      typeof value.target !== 'string' || !/^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*$/.test(value.target) ||
      !/^kc_e2e_[a-f0-9]{8}$/.test(value.username) || typeof value.root !== 'string' ||
      typeof value.runRoot !== 'string' || resolve(value.runRoot) !== value.runRoot) fail('owner_changed');
  const root = win32.normalize(value.root);
  if (root.toLowerCase() !== win32.join('D:\\', `kcoder-package-${value.owner}`).toLowerCase()) fail('owner_changed');
  return { owner: value.owner, runRoot: value.runRoot, target: value.target, root, username: value.username };
}
function matches(actual, expected) { if (!equal(binding(actual), binding(expected))) fail('owner_changed'); }
function times(value) {
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt !== value.createdAt + TTL) fail('record_invalid');
}
function current(locator, now) {
  times(locator);
  if (!Number.isSafeInteger(now) || now < locator.createdAt || now > locator.expiresAt) fail('expired');
}
async function optional(path, limit) {
  try { return await readPrivate(path, undefined, limit); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function validSid(value, owner, sid) {
  return keys(value, ['owner', 'sid', 'version']) && value.version === 1 && value.owner === owner &&
    typeof sid === 'string' && sidPattern.test(sid) && value.sid === sid;
}
async function owner(context, locator, scratch, record, initiallyNew) {
  let confirmed = false, sidBinding = locator.sidBinding ?? null, sidPublished = false;
  if (!initiallyNew) record.remoteStarted = true;
  const dataPath = join(scratch.path, 'record.json'), proofPath = join(scratch.path, 'proof.json');
  const startedPath = join(scratch.path, 'started.json'), sidPath = join(scratch.path, 'sid.json');
  const verify = async expected => {
    await verifyDirectory(locator.base.path, locator.base.identity); await verifyDirectory(scratch.path, locator.scratch);
    matches(locator.binding, expected);
    const proof = await readPrivate(proofPath, locator.proofFile, 1024);
    const data = await readPrivate(dataPath, locator.recordFile, 2048);
    if (!keys(proof.value, ['version', 'owner', 'recordSha256', 'bindingSha256']) || proof.value.version !== 1 ||
        proof.value.owner !== locator.binding.owner || proof.value.recordSha256 !== data.sha256 ||
        proof.value.bindingSha256 !== digest(JSON.stringify(locator.binding))) fail('proof_changed');
    if (!keys(data.value, ['version', 'binding', 'createdAt', 'expiresAt', 'password']) || data.value.version !== 1 ||
        data.value.createdAt !== locator.createdAt || data.value.expiresAt !== locator.expiresAt ||
        typeof data.value.password !== 'string' || data.value.password.length < 32 || data.value.password.length > 128) fail('record_invalid');
    matches(data.value.binding, expected); return data.value;
  };
  context.addCleanup('retain or remove original private keyring recovery channel', () => safe(async () => {
    if (record.remoteStarted && !confirmed) fail('retained_cleanup_unconfirmed');
    if (record.remoteStarted) await verify(locator.binding);
    await context.confirmOwnedScratchCleanup(scratch);
  }));
  return {
    descriptor: () => structuredClone({ ...locator, sidBinding, scratch: { ...scratch } }),
    markRemoteMayExist: () => safe(async () => {
      current(locator, Date.now()); await verify(locator.binding);
      record.remoteStarted = true;
      await writePrivate(startedPath, { owner: locator.binding.owner, version: 1 }, 256); await syncDirectory(scratch.path);
    }),
    bindSid: sid => safe(async () => {
      if (typeof sid !== 'string' || !sidPattern.test(sid)) fail('sid_changed');
      await verify(locator.binding);
      if (sidBinding && sidBinding.sid !== sid) fail('sid_changed');
      const previous = sidBinding ? await readPrivate(sidPath, sidBinding.identity, 256) : await optional(sidPath, 256);
      if ((previous && !validSid(previous.value, locator.binding.owner, sid)) || (!previous && !initiallyNew)) fail('sid_changed');
      const born = previous ?? await writePrivate(sidPath, { owner: locator.binding.owner, sid, version: 1 }, 256);
      sidBinding = { sid, identity: born.identity }; await syncDirectory(scratch.path);
      if (!sidPublished) {
        await context.writeArtifactJsonInternal('keyring-recovery-sid-locator.json', { ...locator, sidBinding, scratch: { ...scratch } });
        sidPublished = true;
      }
    }),
    withPassword: (expected, sid, callback) => safe(async () => {
      current(locator, Date.now());
      if (typeof callback !== 'function') fail('invalid');
      if (!sidBinding || sidBinding.sid !== sid) fail('sid_changed');
      const data = await verify(expected), original = await readPrivate(sidPath, sidBinding.identity, 256);
      if (!validSid(original.value, locator.binding.owner, sid)) fail('sid_changed');
      context.registerSecret(data.password);
      // Only a separately reviewed controller may use this callback for the original SID's protected stdin.
      // Never return the callback value, including through an exception or a retained cause.
      await callback(data.password);
    }),
    confirmRemoteCleanup: value => safe(async () => {
      current(locator, Date.now());
      if (value?.owner !== locator.binding.owner || value.cleaned !== true || value.accountAbsent !== true ||
          value.profileAbsent !== true || value.rootAbsent !== true) fail('cleanup_unconfirmed');
      const original = sidBinding ? await readPrivate(sidPath, sidBinding.identity, 256) : await optional(sidPath, 256);
      const neverBorn = value.disposition === 'never_created' && value.ownedSid == null && !original;
      if (!neverBorn && (value.allJobsStopped !== true || value.vault?.safeToRemoveRoot !== true ||
          (value.vault.systemEntryAbsenceVerified !== true && value.vault.noPrivateWriteDispatched !== true))) fail('cleanup_unconfirmed');
      if (!neverBorn && (!sidBinding || sidBinding.sid !== value.ownedSid || !original ||
          !validSid(original.value, locator.binding.owner, value.ownedSid))) fail('sid_changed');
      await verify(locator.binding); confirmed = true; record.confirmed = true;
    }),
  };
}

export const createKeyringRecovery = (context, selectedBinding, password, options = {}) => safe(async () => {
  const selected = binding(selectedBinding), now = Date.now();
  if (selected.runRoot !== context.runRoot || typeof password !== 'string' || password.length < 32 || password.length > 128) fail('invalid');
  times({ createdAt: now, expiresAt: now + TTL }); context.registerSecret(password);
  const base = await privateRecoveryBase(options.namespace); let slot;
  for (let index = 0; index < 8; index++) {
    const path = join(base.path, `slot-${index}.json`);
    try { slot = { path, ...(await writePrivate(path, { owner: selected.owner, version: 1 }, 256)) }; break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  if (!slot) fail('capacity');
  const record = { confirmed: false, remoteStarted: false }; let scratch;
  context.addCleanup('release original private keyring recovery reservation', () => safe(async () => {
    if ((record.remoteStarted && !record.confirmed) || (scratch && !['removed', 'already-absent'].includes(scratch.cleanupStatus))) fail('retained_cleanup_unconfirmed');
    await verifyDirectory(base.path, base.identity); await removePrivate(slot.path, slot.identity); await syncDirectory(base.path);
  }));
  scratch = await context.createOwnedScratchDirectory('keyring-recovery', { baseDirectory: base.path, requiredBytes: 8192,
    requireCleanupConfirmation: true });
  context.addCleanup('confirm recovery allocation without remote account effects', async () => {
    if (!record.remoteStarted) await context.confirmOwnedScratchCleanup(scratch);
  });
  const createdAt = now, expiresAt = now + TTL;
  const data = await writePrivate(join(scratch.path, 'record.json'), { version: 1, binding: selected, createdAt, expiresAt, password }, 2048);
  const proof = await writePrivate(join(scratch.path, 'proof.json'), { version: 1, owner: selected.owner,
    bindingSha256: digest(JSON.stringify(selected)), recordSha256: data.sha256 }, 1024);
  await syncDirectory(scratch.path); await syncDirectory(base.path);
  const locator = { version: 1, binding: selected, createdAt, expiresAt, base, scratch: { ...scratch },
    slot: { path: slot.path, identity: slot.identity }, recordFile: data.identity, proofFile: proof.identity };
  const channel = await owner(context, locator, scratch, record, true);
  await context.writeArtifactJson('keyring-recovery-locator.json', channel.descriptor()); return channel;
});

export const openKeyringRecovery = (context, locator, expected) => safe(async () => {
  if (locator?.version !== 1) fail('invalid');
  times(locator); matches(locator.binding, expected);
  if (resolve(locator.scratch.basePath) !== locator.base.path || resolve(locator.slot.path) !== join(locator.base.path, locator.slot.path.split('/').at(-1)) ||
      !/^slot-[0-7]\.json$/.test(locator.slot.path.split('/').at(-1))) fail('owner_changed');
  await verifyDirectory(locator.base.path, locator.base.identity);
  const marker = await readPrivate(join(locator.base.path, 'namespace.json'), undefined, 512);
  if (!equal(marker.value, { version: 1, kind: 'keyring-recovery', ...locator.base.identity })) fail('namespace_changed');
  const slot = await readPrivate(locator.slot.path, locator.slot.identity, 256);
  if (!keys(slot.value, ['owner', 'version']) || slot.value.owner !== locator.binding.owner || slot.value.version !== 1) fail('owner_changed');
  // This only adopts the original private local resource. It never starts a logon or remote action.
  // Missing/replaced resources stay unknown and cannot be replaced with a new password or TTL.
  await readPrivate(join(locator.scratch.path, 'record.json'), locator.recordFile, 2048);
  await readPrivate(join(locator.scratch.path, 'proof.json'), locator.proofFile, 1024);
  let scratch; const record = { confirmed: false, remoteStarted: true };
  context.addCleanup('release resumed private keyring recovery reservation', () => safe(async () => {
    if (!record.confirmed || !scratch || !['removed', 'already-absent'].includes(scratch.cleanupStatus)) fail('retained_cleanup_unconfirmed');
    await verifyDirectory(locator.base.path, locator.base.identity); await removePrivate(locator.slot.path, locator.slot.identity);
  }));
  scratch = await context.resumeOwnedScratchDirectory(locator.scratch);
  return owner(context, locator, scratch, record, false);
});
