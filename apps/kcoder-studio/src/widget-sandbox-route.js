import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DOCUMENTS = new Map([
  ['/api/widgets/sandbox-v1.html', ['host-v1.html', 'policy-v1.json', false]],
  ['/widget-sandbox/host-v1.html', ['host-v1.html', 'policy-v1.json', false]],
  ['/api/widgets/isolated-v1.html', ['isolated-v1.html', 'isolated-policy-v1.json', true]],
  ['/widget-sandbox/isolated-v1.html', ['isolated-v1.html', 'isolated-policy-v1.json', true]],
]);
const DOCUMENT_LIMIT = 4 * 1024 * 1024;

/** A fixed public runtime only. User HTML and Gateway credentials never enter this response. */
export function createWidgetSandboxRoute({ roots }) {
  // These two fixed documents form a bounded, process-owned build snapshot.
  // Cache verified bytes and their CSP together, never a verdict allowing a
  // later read from mutable disk. A new route instance captures a new build.
  const documents = new Map();
  async function load(document) {
    for (const root of roots) {
      const directory = resolve(root, 'widget-sandbox');
      try {
        const documentPath = resolve(directory, document[0]);
        const policyPath = resolve(directory, document[1]);
        const [directoryInfo, documentInfo, policyInfo] = await Promise.all([
          lstat(directory), lstat(documentPath), lstat(policyPath),
        ]);
        if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
            !documentInfo.isFile() || documentInfo.isSymbolicLink() || documentInfo.size > DOCUMENT_LIMIT ||
            !policyInfo.isFile() || policyInfo.isSymbolicLink() || policyInfo.size > 16 * 1024)
          throw new Error('Invalid fixed widget resource');
        const [body, policyText] = await Promise.all([readFile(documentPath), readFile(policyPath, 'utf8')]);
        const policy = JSON.parse(policyText);
        if (body.length > DOCUMENT_LIMIT || policy.version !== 1 ||
            createHash('sha256').update(body).digest('hex') !== policy.documentSha256 ||
            typeof policy.csp !== 'string' || /[\r\n]/.test(policy.csp) ||
            !policy.csp.includes("default-src 'none'") || !policy.csp.includes("connect-src 'none'") ||
            !policy.csp.includes("base-uri 'none'") ||
            (document[2] && policy.requiresNativeProcessAuthorization !== true))
          throw new Error('Widget runtime integrity mismatch');
        return { body, csp: policy.csp };
      } catch (error) {
        // Only absence can select another configured build root; corrupt builds fail closed.
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
    }
    throw new Error('Widget runtime is not packaged');
  }
  function snapshot(document) {
    const key = document[0];
    let pending = documents.get(key);
    if (!pending) {
      pending = load(document).catch(error => {
        if (documents.get(key) === pending) documents.delete(key);
        throw error;
      });
      documents.set(key, pending);
    }
    return pending;
  }
  return async function serveWidgetSandbox(request, response, pathname) {
    const document = DOCUMENTS.get(pathname);
    if (!document) return false;
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' });
      response.end();
      return true;
    }
    try {
      const { body, csp } = await snapshot(document);
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': `${csp}; frame-ancestors 'self'`,
      });
      response.end(request.method === 'HEAD' ? undefined : body);
      return true;
    } catch {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('Widget runtime is unavailable');
      return true;
    }
  };
}
