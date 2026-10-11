import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';

const keyLoads = new Map();
const failure = () => new Error('无法保护或读取已保存的 SSH 密码，请重新保存密码并检查 Gateway 私有存储');
const binding = profile => JSON.stringify([profile.id, profile.host, profile.port, profile.username, profile.authMethod]);

export function validateEncryptedPassword(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['scheme', 'data'].includes(key))
    || !['dpapi-user-v1', 'aes-gcm-v1'].includes(value.scheme)
    || typeof value.data !== 'string' || value.data.length > 32768
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) throw failure();
}

async function privateKey(path, create) {
  if (keyLoads.has(path)) return keyLoads.get(path);
  const operation = (async () => {
    if (create) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      let file;
      try {
        file = await open(path, 'wx', 0o600);
        await file.writeFile(randomBytes(32));
        await file.sync();
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      finally { await file?.close(); }
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== 32 || (stat.mode & 0o077) !== 0
        || (process.getuid && stat.uid !== process.getuid())) throw failure();
      const key = Buffer.alloc(32);
      const { bytesRead } = await file.read(key, 0, 32, 0);
      if (bytesRead !== 32) throw failure();
      return key;
    } finally { await file.close(); }
  })();
  keyLoads.set(path, operation);
  try { return await operation; }
  finally { if (keyLoads.get(path) === operation) keyLoads.delete(path); }
}

function dpapi(operation, data, entropy) {
  // Secrets travel through stdin, never argv, environment variables or diagnostics.
  const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';Add-Type -AssemblyName System.Security;$j=[Console]::In.ReadToEnd()|ConvertFrom-Json;$d=[Convert]::FromBase64String($j.data);$e=[Convert]::FromBase64String($j.entropy);if($j.operation -eq 'protect'){$r=[Security.Cryptography.ProtectedData]::Protect($d,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)}else{$r=[Security.Cryptography.ProtectedData]::Unprotect($d,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)};[Console]::Out.Write([Convert]::ToBase64String($r))`;
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 10000, maxBuffer: 128 * 1024 }, (error, stdout) => {
        if (error || !/^[A-Za-z0-9+/]+={0,2}$/.test(stdout.trim())) reject(failure());
        else resolve(Buffer.from(stdout.trim(), 'base64'));
      });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ operation, data: data.toString('base64'), entropy: entropy.toString('base64') }));
  });
}

export function createSshCredentialCipher({ keyPath }) {
  return {
    async encrypt(password, profile) {
      try {
        const data = Buffer.from(password, 'utf8');
        const aad = Buffer.from(binding(profile));
        if (process.platform === 'win32') return { scheme: 'dpapi-user-v1', data: (await dpapi('protect', data, aad)).toString('base64') };
        const key = await privateKey(keyPath, true);
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(aad);
        const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
        return { scheme: 'aes-gcm-v1', data: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64') };
      } catch { throw failure(); }
    },
    async decrypt(value, profile) {
      try {
        validateEncryptedPassword(value);
        const data = Buffer.from(value.data, 'base64');
        const aad = Buffer.from(binding(profile));
        if (value.scheme === 'dpapi-user-v1') {
          if (process.platform !== 'win32') throw failure();
          return (await dpapi('unprotect', data, aad)).toString('utf8');
        }
        if (process.platform === 'win32' || data.length < 29) throw failure();
        const key = await privateKey(keyPath, false);
        const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
        decipher.setAAD(aad);
        decipher.setAuthTag(data.subarray(12, 28));
        return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
      } catch { throw failure(); }
    },
  };
}
