import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const failure = () => new Error('KCoder 账号认证或隔离启动失败，请检查账号和服务器部署');

// Hide the privileged authentication frame from the app-server broker and all clients.
export function authenticatedAccountProcess(child, { username, password, workspace }, { onAuthenticated, onFailure } = {}) {
  const proxy = new EventEmitter();
  const output = new PassThrough();
  proxy.stdin = child.stdin;
  proxy.stdout = output;
  proxy.stderr = child.stderr;
  proxy.kill = signal => child.kill(signal);
  for (const key of ['pid', 'exitCode', 'signalCode', 'killed']) {
    Object.defineProperty(proxy, key, { get: () => child[key] });
  }
  let buffered = Buffer.alloc(0);
  let authenticated = false;
  let failed = false;
  const reject = (reason = 'authentication', authenticationRejected = false) => {
    if (failed) return;
    failed = true;
    process.stderr.write(`[kcoder-account] Connection failed at ${reason} (exit=${child.exitCode ?? 'pending'})\n`);
    clearTimeout(timer);
    onFailure?.({ authenticationRejected });
    child.kill();
    const error = failure();
    error.authenticationRejected = authenticationRejected;
    proxy.emit('error', error);
  };
  const timer = setTimeout(reject, 20000);
  timer.unref?.();
  child.stdout.on('data', chunk => {
    if (failed) return;
    if (authenticated) {
      if (!output.write(chunk)) child.stdout.pause();
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf(10);
    if (end < 0) {
      if (buffered.length > 4096) reject();
      return;
    }
    if (end > 4096) return reject();
    let response;
    try { response = JSON.parse(buffered.subarray(0, end).toString('utf8')); }
    catch { return reject('response-json'); }
    if (!response || typeof response !== 'object' || Array.isArray(response) || response.protocol !== 'kcoder-account-v1' || response.authenticated !== true ||
        response.username !== username || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(response.principalId) ||
        !Number.isInteger(response.uid) || response.uid < 1000 || !['admin', 'user'].includes(response.role)) return reject(response?.authenticated === false ? 'server-authentication' : 'response-identity', response?.errorCode === 'authentication_failed');
    authenticated = true;
    clearTimeout(timer);
    onAuthenticated?.({ principalId: response.principalId, username, role: response.role });
    const remaining = buffered.subarray(end + 1);
    if (remaining.length && !output.write(remaining)) child.stdout.pause();
    buffered = Buffer.alloc(0);
  });
  output.on('drain', () => child.stdout.resume());
  child.stdout.on('end', () => {
    if (!authenticated && !failed) reject('response-missing');
    output.end();
  });
  child.on('error', error => {
    const code = /^[A-Z0-9_]{1,32}$/.test(error?.code) ? error.code : 'UNKNOWN';
    process.stderr.write(`[kcoder-account] SSH process failed: ${code}\n`);
    reject();
  });
  child.on('exit', (...args) => proxy.emit('exit', ...args));
  child.on('close', (...args) => {
    if (!authenticated) process.stderr.write(`[kcoder-account] SSH exited before authentication: ${args[0]}\n`);
    clearTimeout(timer);
    output.end();
    proxy.emit('close', ...args);
  });
  const frame = Buffer.from(JSON.stringify({ protocol: 'kcoder-account-v1', username, password,
    ...(workspace ? { workspace } : {}) }) + '\n');
  try { child.stdin.write(frame, () => frame.fill(0)); }
  catch { frame.fill(0); queueMicrotask(reject); }
  return proxy;
}
