import { mkdir, writeFile, rename, open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSshCredentialCipher } from './ssh-credential-cipher.js';

const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/;

// Persisted "remember login" credentials only. The active session credential
// lives in the per-loginOwner account login context; this store never hands a
// saved password to anything that has not gone through an explicit
// (re)verification, and legacy v1 records (keyed by target id alone) survive
// only as a last-username hint so an arbitrary browser profile cannot inherit
// the previous all-targets-shared credential.
const bindingOf = (target, identity) => ({
  id: target.id,
  host: target.host,
  port: target.port ?? 22,
  deviceId: identity.deviceId,
  username: identity.username,
  authMethod: 'kcoder-account',
});

function recordKey(identity, targetId) {
  return `${identity.deviceId} ${targetId}`;
}

export function createAccountCredentialStore({ filePath, keyPath }) {
  const cipher = createSshCredentialCipher({ keyPath });
  let records = {};
  const legacyHints = new Map();
  let loaded = false;
  let queue = Promise.resolve();
  const serialize = operation => {
    const next = queue.then(operation, operation);
    queue = next.catch(() => {});
    return next;
  };
  const persist = async next => {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 2, accounts: next }) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, filePath);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    records = next;
  };
  const requireIdentity = (target, identity, { usernameOptional = false } = {}) => {
    if (!target?.id || typeof target.id !== 'string') throw new Error('无效的运行目标');
    if (!identity || !DEVICE_ID_PATTERN.test(identity.deviceId || '')) throw new Error('缺少有效的登录设备标识');
    if (identity.username === undefined && usernameOptional) return;
    if (typeof identity.username !== 'string' || !/^[a-z][a-z0-9_.-]{1,31}$/.test(identity.username)) throw new Error('KCoder 账号用户名无效');
  };
  return {
    async load() {
      let file;
      let value;
      try {
        file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if (error.code === 'ENOENT') { loaded = true; return; }
        throw new Error('无法读取 KCoder 账号凭据存储');
      }
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 262144 || (process.platform !== 'win32' &&
            ((info.mode & 0o077) || info.uid !== process.getuid()))) throw new Error('不安全的 KCoder 账号凭据文件');
        try { value = JSON.parse(await file.readFile('utf8')); }
        catch { throw new Error('无效的 KCoder 账号凭据存储'); }
      } finally { await file.close(); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的 KCoder 账号凭据存储');
      if (value.version === 1 && value.accounts && typeof value.accounts === 'object' && !Array.isArray(value.accounts)) {
        // v1 records were scoped to the target id only, so any browser session
        // on this Gateway could reuse them. Keep the username as a hint and
        // drop the secrets; the next remembered login re-saves them scoped.
        for (const record of Object.values(value.accounts)) {
          const username = typeof record?.binding === 'string'
            ? (JSON.parse(record.binding || '{}')?.username ?? '').split('/').pop()
            : undefined;
          if (username && typeof record?.binding === 'string' && record.binding.includes('"id"')) {
            const parsed = JSON.parse(record.binding);
            legacyHints.set(parsed.id, username);
          }
        }
        await persist({});
        loaded = true;
        return;
      }
      if (value.version !== 2 || !value.accounts || typeof value.accounts !== 'object' || Array.isArray(value.accounts)) throw new Error('无效的 KCoder 账号凭据存储');
      records = value.accounts;
      loaded = true;
    },
    requireLoaded() {
      if (!loaded) throw new Error('KCoder 账号凭据存储尚未加载');
    },
    legacyUsername(target) {
      return legacyHints.get(target?.id);
    },
    // Persist a remembered credential bound to this device profile, target and
    // account username. Never called before the server verified the password.
    save(identity, target, password) {
      return serialize(async () => {
        requireIdentity(target, identity);
        if (typeof password !== 'string' || Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 1024) throw new Error('KCoder 账号密码长度无效');
        const bound = JSON.stringify(bindingOf(target, identity));
        const encrypted = await cipher.encrypt(password, bindingOf(target, identity));
        await persist({ ...records, [recordKey(identity, target.id)]: { binding: bound, password: encrypted } });
      });
    },
    // Server-side auto login: decrypt the remembered credential for this
    // device profile and target, or return null when absent. The username
    // comes from the stored binding; a caller-provided username must match.
    // Callers must still verify the credential with the remote account entry.
    async recall(identity, target) {
      requireIdentity(target, identity, { usernameOptional: true });
      const record = records[recordKey(identity, target.id)];
      if (!record || typeof record.binding !== 'string') return null;
      let stored;
      try { stored = JSON.parse(record.binding); } catch { return null; }
      if (identity.username !== undefined && stored?.username !== identity.username) return null;
      const bound = bindingOf(target, { deviceId: identity.deviceId, username: stored?.username });
      if (record.binding !== JSON.stringify(bound)) return null;
      try {
        const password = await cipher.decrypt(record.password, bound);
        return { username: bound.username, password };
      } catch {
        return null;
      }
    },
    async forgetIdentity(identity, target) {
      await serialize(async () => {
        requireIdentity(target, identity);
        if (!Object.hasOwn(records, recordKey(identity, target.id))) return;
        const next = { ...records };
        delete next[recordKey(identity, target.id)];
        await persist(next);
      });
    },
    // Drop any remembered credential for this device profile and target,
    // regardless of which username it was saved for (logout cleanup).
    async forgetDevice(deviceId, target) {
      await serialize(async () => {
        requireIdentity(target, { deviceId });
        const key = recordKey({ deviceId }, target.id);
        if (!Object.hasOwn(records, key)) return;
        const next = { ...records };
        delete next[key];
        await persist(next);
      });
    },
    // Drop every remembered credential for a target (target deleted or its
    // connection parameters changed, which invalidates the binding).
    async forgetTarget(target) {
      await serialize(async () => {
        if (!target?.id) throw new Error('无效的运行目标');
        const next = { ...records };
        let changed = false;
        for (const key of Object.keys(next)) {
          if (!key.endsWith(` ${target.id}`)) continue;
          delete next[key];
          changed = true;
        }
        legacyHints.delete(target.id);
        if (changed) await persist(next);
      });
    },
  };
}
