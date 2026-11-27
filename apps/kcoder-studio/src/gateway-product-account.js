import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const accountPath = '/_relay/account/session';
const codePattern = /^[A-Za-z0-9_-]{43}$/;
export const PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE = '.product-account-cookie-scope.json';
const scopeRecordLimit = 4096;
const operationPattern = /^[A-Za-z0-9_-]{1,128}$/;
const scopeFailure = code => Object.assign(new Error(code), { code });

function absoluteRoot(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') &&
    resolve(value) === value;
}

function scopeRecordPath(root) { return join(root, PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE); }

function validateScopeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 ||
      !absoluteRoot(value.scopeRoot) || Object.keys(value).length !== 2 ||
      Object.keys(value).some(key => !['version', 'scopeRoot'].includes(key))) {
    throw scopeFailure('PRODUCT_ACCOUNT_COOKIE_SCOPE_INVALID');
  }
  return value;
}

async function readScopeRecord(root) {
  const path = scopeRecordPath(root);
  let named;
  try { named = await lstat(path, { bigint: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw scopeFailure('PRODUCT_ACCOUNT_COOKIE_SCOPE_UNAVAILABLE');
  }
  const validStat = info => info.isFile() && !info.isSymbolicLink() && info.nlink === 1n && info.size <= BigInt(scopeRecordLimit);
  if (!validStat(named)) throw scopeFailure('PRODUCT_ACCOUNT_COOKIE_SCOPE_INVALID');
  let file;
  try { file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch { throw scopeFailure('PRODUCT_ACCOUNT_COOKIE_SCOPE_UNAVAILABLE'); }
  try {
    const held = await file.stat({ bigint: true });
    if (!validStat(held) || held.dev !== named.dev || held.ino !== named.ino) {
      throw scopeFailure('PRODUCT_ACCOUNT_COOKIE_SCOPE_INVALID');
    }
    const buffer = Buffer.alloc(scopeRecordLimit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > scopeRecordLimit) throw scopeFailure('PRODUCT_ACCOUNT_COOKIE_SCOPE_INVALID');
    let afterRead, namedAfter;
    try { [afterRead, namedAfter] = await Promise.all([file.stat({ bigint: true }), lstat(path, { bigint: true })]); }
    catch { throw scopeFailure('PRODUCT_ACCOUNT_COOKIE_SCOPE_UNAVAILABLE'); }
    const sameFile = info => validStat(info) && info.dev === held.dev && info.ino === held.ino &&
      info.size === held.size && info.mtimeNs === held.mtimeNs && info.ctimeNs === held.ctimeNs;
    if (BigInt(length) !== held.size || !sameFile(afterRead) || !sameFile(namedAfter)) {
      throw scopeFailure('PRODUCT_ACCOUNT_COOKIE_SCOPE_INVALID');
    }
    const bytes = buffer.subarray(0, length);
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw scopeFailure('PRODUCT_ACCOUNT_COOKIE_SCOPE_INVALID'); }
    const canonical = Buffer.from(JSON.stringify(value) + '\n');
    if (!bytes.equals(canonical)) throw scopeFailure('PRODUCT_ACCOUNT_COOKIE_SCOPE_INVALID');
    validateScopeRecord(value);
    return { value, bytes };
  } finally { await file.close(); }
}

async function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const directory = await open(path, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function writeScopeRecord(root, value) {
  const path = scopeRecordPath(root);
  const temporary = join(root, `${PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE}.tmp`);
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  if (bytes.length > scopeRecordLimit) throw scopeFailure('PRODUCT_ACCOUNT_COOKIE_SCOPE_INVALID');
  let created = false;
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0));
    created = true;
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try { await link(temporary, path); }
    catch (error) {
      if (error.code === 'EEXIST') throw scopeFailure('PRODUCT_ACCOUNT_COOKIE_SCOPE_INVALID');
      throw scopeFailure('PRODUCT_ACCOUNT_COOKIE_SCOPE_UNAVAILABLE');
    }
    await unlink(temporary);
    created = false;
    await syncDirectory(root);
    const written = await readScopeRecord(root);
    if (!written || !written.bytes.equals(bytes)) throw scopeFailure('PRODUCT_ACCOUNT_COOKIE_SCOPE_INVALID');
    return written;
  } catch (error) {
    if (error?.code?.startsWith('PRODUCT_ACCOUNT_COOKIE_SCOPE_')) throw error;
    throw scopeFailure('PRODUCT_ACCOUNT_COOKIE_SCOPE_UNAVAILABLE');
  } finally {
    if (created) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function validateMigrationInput({ source, finalTarget, operationId, validateOffline }) {
  if (!absoluteRoot(source) || !absoluteRoot(finalTarget) || source === finalTarget ||
      !operationPattern.test(operationId ?? '') || typeof validateOffline !== 'function') {
    throw scopeFailure('PRODUCT_ACCOUNT_COOKIE_SCOPE_AUTHORITY_REQUIRED');
  }
  return Object.freeze({ domain: 'gateway-product-account-cookie-scope', operationId, source, finalTarget });
}

function requireOffline(validateOffline, facts) {
  if (validateOffline(facts) !== true) throw scopeFailure('PRODUCT_ACCOUNT_COOKIE_SCOPE_AUTHORITY_REQUIRED');
}

/** Freeze only the legacy cookie-name seed under the original Gateway owner. */
export async function prepareProductAccountCookieScopeSource({ source, finalTarget, operationId, validateOffline } = {}) {
  const facts = validateMigrationInput({ source, finalTarget, operationId, validateOffline });
  const sourceFacts = Object.freeze({ ...facts, purpose: 'productAccountScopeSource' });
  requireOffline(validateOffline, sourceFacts);
  const previous = await readScopeRecord(source);
  if (previous) {
    requireOffline(validateOffline, sourceFacts);
    return { version: 1, state: 'frozen' };
  }
  const value = { version: 1, scopeRoot: source };
  await writeScopeRecord(source, value);
  requireOffline(validateOffline, sourceFacts);
  const written = await readScopeRecord(source);
  if (!written?.bytes.equals(Buffer.from(JSON.stringify(value) + '\n'))) {
    throw scopeFailure('PRODUCT_ACCOUNT_COOKIE_SCOPE_INVALID');
  }
  requireOffline(validateOffline, sourceFacts);
  return { version: 1, state: 'frozen' };
}

/** Verify the copied seed after the parent proves the published target. */
export async function verifyProductAccountCookieScopeRelocation({ source, finalTarget, operationId, validateOffline } = {}) {
  const facts = validateMigrationInput({ source, finalTarget, operationId, validateOffline });
  const publishedFacts = Object.freeze({ ...facts, purpose: 'productAccountScopePublished' });
  requireOffline(validateOffline, publishedFacts);
  const [sourceRecord, targetRecord] = await Promise.all([readScopeRecord(source), readScopeRecord(finalTarget)]);
  if (!sourceRecord || !targetRecord) throw scopeFailure('PRODUCT_ACCOUNT_COOKIE_SCOPE_INVALID');
  if (sourceRecord.value.scopeRoot !== targetRecord.value.scopeRoot || !sourceRecord.bytes.equals(targetRecord.bytes)) {
    throw scopeFailure('PRODUCT_ACCOUNT_COOKIE_SCOPE_INVALID');
  }
  requireOffline(validateOffline, publishedFacts);
  return { version: 1, state: 'verified' };
}

/** Missing is the legacy format; an existing malformed or misplaced record never falls back. */
export async function loadProductAccountCookieScopeRoot(storageRoot) {
  const stored = await readScopeRecord(storageRoot);
  if (!stored) return storageRoot;
  return validateScopeRecord(stored.value).scopeRoot;
}

export function productAccountIssuer(env) {
  try {
    const value = env.KCODER_STUDIO_RELAY_DEFAULT_URL || env.KCODER_STUDIO_RELAY_ORIGIN || env.KCODER_RELAY_PUBLIC_URL;
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash)
      return url.origin;
  } catch {}
  return null;
}

export function productAccountCookieScope(storageRoot, path, issuer) {
  return '_account_' + createHash('sha256').update(JSON.stringify([storageRoot, path, issuer])).digest('hex').slice(0, 24);
}

export function validAccountProof(value) {
  return typeof value === 'string' && codePattern.test(value);
}

function invitationCode(input, issuer) {
  if (typeof input !== 'string' || input.length > 2048) return null;
  const value = input.trim();
  if (codePattern.test(value)) return value;
  try {
    const link = new URL(value);
    const code = new URLSearchParams(link.hash.slice(1));
    if (link.origin === issuer && link.pathname === '/_relay/login' && !link.username && !link.password &&
        !link.search && [...code.keys()].length === 1 && codePattern.test(code.get('code') ?? ''))
      return code.get('code');
  } catch {}
  return null;
}

export async function updateProductAccount({ issuer, proof, method, input, fetchImpl = fetch }) {
  if (!issuer) return { status: method === 'GET' ? 200 : 503, body: { available: false, account: null } };
  if (!proof) return { status: 403, body: { error: 'KCODER_ACCOUNT_BROWSER_REQUIRED' } };
  const code = method === 'POST' && invitationCode(input?.invitation, issuer);
  if (method === 'POST' && !code) return { status: 400, body: { error: 'KCODER_ACCOUNT_INVITATION_INVALID' } };
  try {
    const response = await fetchImpl(new URL(accountPath, issuer), {
      method,
      headers: { authorization: `Bearer ${code || proof}`, ...(code ? { 'content-type': 'application/json' } : {}) },
      ...(code ? { body: JSON.stringify({ sessionToken: proof }) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 401 && method === 'GET') return { status: 200, body: { available: true, account: null } };
    if (response.ok) {
      const { account } = await response.json();
      if (method === 'DELETE') return { status: 200, body: { available: true, account: null } };
      if (typeof account?.id === 'string' && typeof account.username === 'string') {
        const { sessionExpiresAt } = account;
        if (sessionExpiresAt === null || sessionExpiresAt === undefined || Number.isSafeInteger(sessionExpiresAt)) {
          return { status: 200, sessionExpiresAt,
            body: { available: true, account: { id: account.id, username: account.username } } };
        }
      }
    }
    if ([401, 409, 429].includes(response.status)) {
      await response.body?.cancel();
      const error = { 401: 'KCODER_ACCOUNT_INVITATION_REJECTED', 409: 'KCODER_ACCOUNT_ALREADY_SIGNED_IN',
        429: 'KCODER_ACCOUNT_RATE_LIMITED' }[response.status];
      return { status: response.status, body: { error } };
    }
    await response.body?.cancel();
  } catch {}
  return { status: 503, body: { error: 'KCODER_ACCOUNT_UNAVAILABLE' } };
}
