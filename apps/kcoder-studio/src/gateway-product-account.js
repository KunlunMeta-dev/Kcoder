import { createHash } from 'node:crypto';

const accountPath = '/_relay/account/session';
const codePattern = /^[A-Za-z0-9_-]{43}$/;

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
