import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { createSshCredentialCipher, validateEncryptedPassword } from './ssh-credential-cipher.js';

const MAX_FILE_BYTES = 256 * 1024;
const queues = new Map();
const PROFILE_FIELDS = ['id', 'label', 'host', 'port', 'username', 'authMethod', 'privateKeyPath'];
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
export const SSH_CONNECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function strictObject(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SSH 参数必须是对象');
  if (Object.keys(value).some((key) => !fields.includes(key))) throw new Error('SSH 配置包含不支持的字段');
}

function stringField(value, name, max, pattern) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > max
      || /[\x00-\x1f\x7f]/.test(value) || (pattern && !pattern.test(value))) {
    throw new Error(`SSH ${name} 无效`);
  }
  return value;
}

export function validateSshProfile(input, { stored = false } = {}) {
  strictObject(input, stored ? [...PROFILE_FIELDS, 'hostFingerprint', 'credentials'] : PROFILE_FIELDS);
  const id = stringField(input.id ?? randomUUID(), '连接 ID', 64, SSH_CONNECTION_ID_PATTERN);
  const label = stringField(input.label, '名称', 120);
  if (!label.trim()) throw new Error('SSH 名称不能为空');
  const host = stringField(input.host, '主机', 253);
  if (!isIP(host) && !/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) throw new Error('SSH 主机无效');
  if (!isIP(host) && host.split('.').some((part) => !part.length || part.length > 63 || part.startsWith('-') || part.endsWith('-'))) throw new Error('SSH 主机无效');
  const port = input.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口必须介于 1 和 65535');
  const username = stringField(input.username, '用户名', 128, /^[A-Za-z0-9_][A-Za-z0-9_.@\\-]*[$]?$/);
  const authMethod = input.authMethod;
  if (!['password', 'key', 'agent'].includes(authMethod)) throw new Error('SSH 认证方式无效');
  const profile = { id, label, host, port, username, authMethod };
  if (input.privateKeyPath !== undefined) {
    const keyPath = stringField(input.privateKeyPath, '私钥路径', 4096);
    if (!isAbsolute(keyPath) || keyPath !== keyPath.trim()) throw new Error('SSH 私钥必须使用 Gateway 主机上的绝对路径');
    if (authMethod !== 'key') throw new Error('仅私钥认证可以设置私钥路径');
    profile.privateKeyPath = keyPath;
  }
  if (authMethod === 'key' && !profile.privateKeyPath) throw new Error('SSH 私钥路径不能为空');
  if (input.hostFingerprint !== undefined) {
    if (!FINGERPRINT.test(input.hostFingerprint)) throw new Error('SSH 主机指纹无效');
    profile.hostFingerprint = input.hostFingerprint;
  }
  if (input.credentials !== undefined) {
    strictObject(input.credentials, ['password']);
    if (authMethod !== 'password') throw new Error('SSH 密码仅适用于密码认证');
    validateEncryptedPassword(input.credentials.password);
    profile.credentials = { password: input.credentials.password };
  }
  return profile;
}

function publicProfile({ credentials, ...profile }) {
  return { ...profile, ...(credentials?.password ? { passwordSaved: true } : {}) };
}

function sameIdentity(left, right) {
  return ['id', 'host', 'port', 'username', 'authMethod'].every(key => left[key] === right[key]);
}

export async function readBoundedRegularFile(filePath, limit = MAX_FILE_BYTES) {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('SSH 文件不是普通文件或超过大小限制');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error('SSH 文件超过大小限制');
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

function parseDocument(raw) {
  const errors = [];
  const document = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error('SSH 连接配置不是有效的 JSONC');
  strictObject(document, ['meta', 'terminal']);
  strictObject(document.meta, ['config_version']);
  if (document.meta.config_version !== 1) throw new Error('SSH 连接配置仅支持 config_version 1');
  strictObject(document.terminal, ['ssh']);
  strictObject(document.terminal.ssh, ['connections']);
  const connections = document.terminal.ssh.connections;
  if (!Array.isArray(connections) || connections.length > 32) throw new Error('SSH 连接最多保存 32 条');
  const profiles = connections.map((value) => {
    if (typeof value?.id !== 'string') throw new Error('SSH 连接缺少 ID');
    return validateSshProfile(value, { stored: true });
  });
  if (new Set(profiles.map(({ id }) => id)).size !== profiles.length) throw new Error('SSH 连接 ID 重复');
  return profiles;
}

const emptyDocument = () => JSON.stringify({ meta: { config_version: 1 }, terminal: { ssh: { connections: [] } } }, null, 2) + '\n';

function updateDocument(raw, profiles) {
  const path = ['terminal', 'ssh', 'connections'];
  const existing = parseDocument(raw);
  let content = raw;
  const edit = (suffix, value) => {
    content = applyEdits(content, modify(content, [...path, ...suffix], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  };
  for (let index = existing.length - 1; index >= 0; index -= 1) {
    if (!profiles.some(({ id }) => id === existing[index].id)) {
      edit([index], undefined);
      existing.splice(index, 1);
    }
  }
  profiles.forEach((profile, index) => {
    if (!existing[index]) {
      edit([-1], profile);
      return;
    }
    // CRUD preserves order; editing individual fields retains adjacent JSONC comments.
    for (const key of [...PROFILE_FIELDS, 'hostFingerprint', 'credentials']) {
      if (existing[index][key] !== profile[key]) edit([index, key], profile[key]);
    }
  });
  return content;
}

export function createSshConnectionStore({ filePath = join(homedir(), '.config', 'kcoder-studio', 'ssh_connections.jsonc'), cipher } = {}) {
  const path = resolve(filePath);
  cipher ??= createSshCredentialCipher({ keyPath: join(dirname(path), 'ssh_credentials.key') });
  function serialized(operation) {
    const previous = queues.get(path) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.catch(() => {});
    queues.set(path, settled);
    settled.then(() => { if (queues.get(path) === settled) queues.delete(path); });
    return result;
  }
  async function read() {
    let raw;
    try { raw = (await readBoundedRegularFile(path)).toString('utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('无法读取 SSH 连接配置');
      raw = emptyDocument();
    }
    return { raw, profiles: parseDocument(raw) };
  }
  async function write(raw, profiles) {
    const content = updateDocument(raw, profiles);
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('SSH 配置超过大小限制');
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path);
    } catch {
      throw new Error('无法保存 SSH 连接配置');
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  return {
    filePath: path,
    list: () => serialized(async () => (await read()).profiles.map(publicProfile)),
    resolvePassword: (expected) => serialized(async () => {
      const profile = (await read()).profiles.find(item => item.id === expected.id);
      if (!profile || !sameIdentity(profile, expected)) throw new Error('SSH 连接配置已变更，请重新连接');
      return profile.credentials?.password ? cipher.decrypt(profile.credentials.password, profile) : undefined;
    }),
    upsert: (input) => serialized(async () => {
      strictObject(input, [...PROFILE_FIELDS, 'password']);
      const { password, ...metadata } = input;
      if (password !== undefined && password !== null && (typeof password !== 'string' || !password.length || Buffer.byteLength(password) > 4096 || password.includes('\0'))) throw new Error('SSH 密码格式或长度无效');
      const profile = validateSshProfile(metadata);
      if (password && profile.authMethod !== 'password') throw new Error('SSH 密码仅适用于密码认证');
      const { raw, profiles } = await read();
      const index = profiles.findIndex(({ id }) => id === profile.id);
      if (index >= 0) {
        const previous = profiles[index];
        if (previous.host === profile.host && previous.port === profile.port && previous.hostFingerprint) profile.hostFingerprint = previous.hostFingerprint;
        if (password === undefined && sameIdentity(previous, profile) && previous.credentials) profile.credentials = previous.credentials;
        profiles[index] = profile;
      } else {
        if (profiles.length >= 32) throw new Error('SSH 连接最多保存 32 条');
        profiles.push(profile);
      }
      if (password) profile.credentials = { password: await cipher.encrypt(password, profile) };
      await write(raw, profiles);
      return publicProfile(profile);
    }),
    delete: (id) => serialized(async () => {
      stringField(id, '连接 ID', 64, SSH_CONNECTION_ID_PATTERN);
      const { raw, profiles } = await read();
      await write(raw, profiles.filter((profile) => profile.id !== id));
      return { deleted: profiles.some((profile) => profile.id === id) };
    }),
    pinFingerprint: (expected, fingerprint) => serialized(async () => {
      if (!FINGERPRINT.test(fingerprint)) throw new Error('SSH 主机指纹无效');
      const { raw, profiles } = await read();
      const profile = profiles.find(({ id }) => id === expected.id);
      if (!profile || PROFILE_FIELDS.some((key) => profile[key] !== expected[key])) throw new Error('SSH 连接配置已变更，请重新连接');
      if (profile.hostFingerprint && profile.hostFingerprint !== fingerprint) throw new Error('SSH 主机指纹已变化，拒绝连接');
      if (!profile.hostFingerprint) {
        profile.hostFingerprint = fingerprint;
        await write(raw, profiles);
      }
    }),
  };
}
