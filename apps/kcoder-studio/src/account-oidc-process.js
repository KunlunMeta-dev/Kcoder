import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { privateOidcResume } from './account-oidc-private.js';

const failure = () => new Error('KCoder OIDC 认证或隔离启动失败，请重新登录');
const principalPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const requestPattern = /^[A-Za-z0-9_-]{16,128}$/;
const httpsEndpoint = value => {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch { return false; }
};
const redirectEndpoint = value => {
  if (httpsEndpoint(value)) return true;
  try {
    const uri = new URL(value);
    return uri.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(uri.hostname) && uri.port && !uri.username && !uri.password && !uri.hash && !uri.search;
  } catch { return false; }
};

// The same owned SSH process performs the original code exchange and then runs
// app-server. Gateway forwards callbacks; it never supplies an identity proof.
export function authenticatedOidcAccountProcess(child, { username, workspace, callbackPort }, {
  onAuthenticated, onFailure, onAuthorizationRequired, retentionParentV1 = false,
} = {}) {
  if (typeof username !== 'string' || typeof retentionParentV1 !== 'boolean') throw failure();
  const proxy = new EventEmitter();
  const output = new PassThrough();
  const clientBinding = randomBytes(32).toString('base64url');
  let buffered = Buffer.alloc(0), queued = [], queuedBytes = 0;
  let authenticated = false, failed = false, pending, submitted = false, stdinEnded = false;
  const reject = () => {
    if (failed) return;
    failed = true;
    clearTimeout(timer);
    queued = []; queuedBytes = 0;
    onFailure?.({ authenticationRejected: true });
    child.kill();
    proxy.emit('error', failure());
  };
  const timer = setTimeout(reject, 225000);
  timer.unref?.();
  proxy.stdin = new Writable({
    write(chunk, encoding, done) {
      if (failed) { done(failure()); return; }
      if (authenticated) { child.stdin.write(chunk, encoding, done); return; }
      if (queuedBytes + chunk.length > 65536) { done(failure()); return; }
      const bytes = Buffer.from(chunk);
      queued.push(bytes); queuedBytes += bytes.length; done();
    },
    final(done) {
      stdinEnded = true;
      if (authenticated) child.stdin.end(done); else done();
    },
  });
  proxy.stdin.on('error', reject);
  proxy.stdout = output;
  proxy.stderr = child.stderr;
  proxy.kill = signal => child.kill(signal);
  Object.defineProperty(proxy, 'oidcAuthorizationPending', { get: () => !authenticated && !failed });
  Object.defineProperty(proxy, 'ownsOidcSessionAuthority', { value: true });
  for (const key of ['pid', 'exitCode', 'signalCode', 'killed']) {
    Object.defineProperty(proxy, key, { get: () => child[key] });
  }
  const writePrivateFrame = frame => {
    const bytes = Buffer.from(JSON.stringify(frame) + '\n');
    if (bytes.length > 8192) throw failure();
    child.stdin.write(bytes, () => bytes.fill(0));
  };
  proxy.submitOidcCallback = ({ requestId, authorizationResponse }) => {
    if (failed || authenticated || !pending || submitted || requestId !== pending.requestId ||
        typeof authorizationResponse !== 'string' || authorizationResponse.length > 7680) throw failure();
    submitted = true;
    writePrivateFrame({ protocol: 'kcoder-account-oidc-code-v1', requestId, authorizationResponse });
  };
  child.stdin.on('error', reject);
  child.stdout.on('data', chunk => {
    if (failed) return;
    if (authenticated) {
      if (!output.write(chunk)) child.stdout.pause();
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    while (!authenticated && !failed) {
      const end = buffered.indexOf(10);
      if (end < 0) { if (buffered.length > 8192) reject(); return; }
      if (end > 8192) { reject(); return; }
      let response;
      try { response = JSON.parse(buffered.subarray(0, end).toString('utf8')); }
      catch { reject(); return; }
      const remaining = buffered.subarray(end + 1);
      buffered.fill(0, 0, end + 1);
      buffered = remaining;
      if (response?.protocol === 'kcoder-account-v1' && response.authenticated === false &&
          response.authenticationPending === true && response.authentication === 'oidc' &&
          !pending && requestPattern.test(response.requestId) && Number.isInteger(response.expiresIn) &&
          response.expiresIn > 0 && response.expiresIn <= 180 && httpsEndpoint(response.authorizationUrl) && redirectEndpoint(response.redirectUri)) {
        pending = Object.freeze({ requestId: response.requestId, authorizationUrl: response.authorizationUrl,
          redirectUri: response.redirectUri, expiresIn: response.expiresIn });
        try { if (onAuthorizationRequired?.(pending) === false) reject(); }
        catch { reject(); }
        continue;
      }
      if (!pending || !submitted || response?.protocol !== 'kcoder-account-v1' || response.authenticated !== true ||
          response.username !== username || !principalPattern.test(response.principalId) ||
          !Number.isInteger(response.uid) || response.uid < 1000 || !['admin', 'user'].includes(response.role)) { reject(); return; }
      try {
        const authority = privateOidcResume(response.privateOidcResume);
        if (authority.clientBinding !== clientBinding || onAuthenticated?.({ principalId: response.principalId, username, role: response.role }, authority) === false) { reject(); return; }
      } catch { reject(); return; }
      authenticated = true;
      clearTimeout(timer);
      for (const bytes of queued) child.stdin.write(bytes);
      queued = []; queuedBytes = 0;
      if (stdinEnded) child.stdin.end();
      if (buffered.length && !output.write(buffered)) child.stdout.pause();
      buffered = Buffer.alloc(0);
    }
  });
  output.on('drain', () => child.stdout.resume());
  child.stdout.on('end', () => { if (!authenticated && !failed) reject(); output.end(); });
  child.on('error', reject);
  child.on('exit', (...args) => proxy.emit('exit', ...args));
  child.on('close', (...args) => {
    clearTimeout(timer);
    queued = []; queuedBytes = 0;
    output.end();
    proxy.emit('close', ...args);
  });
  try {
    writePrivateFrame({ protocol: 'kcoder-account-v1', authentication: 'oidc', username, clientBinding,
      ...(Number.isInteger(callbackPort) && callbackPort > 0 && callbackPort <= 65535 ? { callbackPort } : {}),
      ...(workspace ? { workspace } : {}), ...(retentionParentV1 ? { retentionParentV1: true } : {}) });
  } catch { queueMicrotask(reject); }
  return proxy;
}
