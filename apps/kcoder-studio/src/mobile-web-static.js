import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

// Public presentation only. This proof never authorizes an API or RPC request.
const DOMAIN = 'kcoder-mobile-mount-v1';
const TOKEN = '/__kcoder_mobile_mount_v1__';
const MANIFEST = 'kcoder-mobile-web.json';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const safeName = name => typeof name === 'string' && name.length <= 1024 && !name.startsWith('/') && !/[\\\x00-\x1f\x7f%?#]/.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..' && (!part.startsWith('.') || name === '_expo/.routes.json'));

export function mobilePresentationMount(request, { publicOrigins, pairingToken, directPort }) {
  const authority = request.headers.host;
  if (typeof authority !== 'string' || /[\s\\/@?#]/.test(authority)) throw new Error('Invalid mobile authority');
  const canonical = new URL(`http://${authority}`).host;
  if (canonical !== authority.toLowerCase()) throw new Error('Invalid mobile authority');
  const prefix = request.headers['x-kcoder-mobile-mount'];
  const signature = request.headers['x-kcoder-mobile-mount-proof'];
  if (prefix !== undefined || signature !== undefined) {
    if (typeof prefix !== 'string' || !/^\/g\/[A-Za-z0-9_-]{1,64}$/.test(prefix) ||
        typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature) || !pairingToken) throw new Error('Invalid mobile mount proof');
    const matches = [...publicOrigins].filter(value => new URL(value).host === canonical);
    if (matches.length !== 1) throw new Error('Mobile public origin is not configured unambiguously');
    const expected = createHmac('sha256', pairingToken).update(JSON.stringify([DOMAIN, canonical, prefix])).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new Error('Invalid mobile mount proof');
    return { origin: matches[0], prefix, basePath: `${prefix}/mobile` };
  }
  const configured = [...publicOrigins].filter(value => new URL(value).host === canonical);
  if (configured.length > 1) throw new Error('Ambiguous mobile public origin');
  const localAuthorities = ['127.0.0.1', 'localhost', '[::1]'].map(value => new URL(`http://${value}:${directPort()}`).host);
  if (!configured.length && !localAuthorities.includes(canonical)) throw new Error('Mobile public origin is not configured');
  return { origin: configured[0] ?? `${request.socket.encrypted ? 'https' : 'http'}://${canonical}`, prefix: '', basePath: '/mobile' };
}

/** The manifest is build-owned; only its exact, hash-verified resources are public. */
export function createMobileWebStatic({ root, publicOrigins, pairingToken, contentSecurityPolicy, directPort }) {
  const directory = resolve(root);
  let inventory;
  const resourceCache = new Map();
  let cachedBytes = 0;
  const cacheBudget = 32 * 1024 * 1024;
  function cacheResource(name, bytes) {
    const previous = resourceCache.get(name);
    if (previous) { cachedBytes -= previous.length; resourceCache.delete(name); }
    while (resourceCache.size && (cachedBytes + bytes.length > cacheBudget || resourceCache.size >= 256)) {
      const first = resourceCache.keys().next().value;
      cachedBytes -= resourceCache.get(first).length;
      resourceCache.delete(first);
    }
    if (bytes.length <= cacheBudget) { resourceCache.set(name, bytes); cachedBytes += bytes.length; }
  }
  async function verifiedFile(name, maxBytes) {
    if (!safeName(name)) throw new Error('Invalid mobile resource');
    let current = directory;
    const rootInfo = await lstat(current);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(current) !== current) throw new Error('Invalid mobile build root');
    for (const part of name.split('/')) {
      current = resolve(current, part);
      if (!current.startsWith(directory + sep)) throw new Error('Invalid mobile resource');
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Mobile build symlink is not allowed');
    }
    const info = await lstat(current);
    if (!info.isFile() || info.size > maxBytes) throw new Error('Invalid mobile resource size');
    const bytes = await readFile(current);
    if (bytes.length !== info.size || bytes.length > maxBytes) throw new Error('Mobile resource changed');
    return bytes;
  }
  async function loadInventory() {
    if (inventory) return inventory;
    let bytes;
    try { bytes = await verifiedFile(MANIFEST, 4 * 1024 * 1024); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (parsed.version !== 1 || parsed.baseToken !== TOKEN || !Array.isArray(parsed.files) || parsed.files.length > 10000) throw new Error('Invalid mobile build manifest');
    const files = new Map();
    let total = 0;
    for (const row of parsed.files) {
      if (!safeName(row.path) || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.size) || row.size < 0 || row.size > 32 * 1024 * 1024 ||
          typeof row.text !== 'boolean' || !Number.isSafeInteger(row.replacements) || row.replacements < 0 || (!row.text && row.replacements !== 0) ||
          /\.(?:map|gz|br)$/i.test(row.path) || files.has(row.path)) throw new Error('Invalid mobile build resource');
      files.set(row.path, row); total += row.size;
    }
    if (total > 256 * 1024 * 1024 || !files.has('index.html') || !parsed.files.some(row => row.replacements > 0)) throw new Error('Incomplete mobile build');
    inventory = { files, sha256: digest(bytes) };
    return inventory;
  }
  function send(response, status, type, body, method, extraHeaders = {}) {
    response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': contentSecurityPolicy, 'referrer-policy': 'no-referrer', 'content-length': Buffer.byteLength(body), ...extraHeaders });
    response.end(method === 'HEAD' ? undefined : body);
  }
  return async function serveMobile(request, response, pathname) {
    if (pathname !== '/mobile-entry' && pathname !== '/mobile' && !pathname.startsWith('/mobile/')) return false;
    if (request.method !== 'GET' && request.method !== 'HEAD') { send(response, 405, 'text/plain', 'Method not allowed', request.method); return true; }
    let mount;
    try { mount = mobilePresentationMount(request, { publicOrigins, pairingToken, directPort }); }
    catch { send(response, 403, 'text/plain', 'Invalid mobile mount', request.method); return true; }
    const build = await loadInventory();
    if (pathname === '/mobile-entry') {
      const body = JSON.stringify({ version: 1, available: Boolean(build), mobileUrl: `${mount.origin}${mount.basePath}/`, gatewayUrl: `${mount.origin}${mount.prefix}` });
      send(response, 200, 'application/json; charset=utf-8', body, request.method); return true;
    }
    if (!build) { send(response, 404, 'text/plain', 'Mobile Web build is not installed', request.method); return true; }
    if (pathname === '/mobile') { response.writeHead(308, { location: `${mount.basePath}/${new URL(request.url, 'http://localhost').search}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); response.end(); return true; }
    const raw = request.url.split(/[?#]/, 1)[0];
    if (/%(?:2e|2f|5c|00)/i.test(raw) || raw.split('/').some(part => part === '.' || part === '..')) { send(response, 404, 'text/plain', 'Not found', request.method); return true; }
    let relative;
    try { relative = decodeURIComponent(pathname.slice('/mobile/'.length)).replace(/\/$/, ''); }
    catch { send(response, 404, 'text/plain', 'Not found', request.method); return true; }
    if (relative && !safeName(relative)) { send(response, 404, 'text/plain', 'Not found', request.method); return true; }
    let name = relative || 'index.html';
    if (!build.files.has(name)) {
      if (build.files.has(`${name}.html`)) name += '.html';
      else if (!/\.[^/]+$/.test(name) && !name.startsWith('_expo/') && !name.startsWith('assets/')) name = 'index.html';
      else { send(response, 404, 'text/plain', 'Not found', request.method); return true; }
    }
    const row = build.files.get(name);
    let original = resourceCache.get(name);
    if (!original) {
      original = await verifiedFile(name, row.size);
      if (digest(original) !== row.sha256) throw new Error('Mobile build resource hash mismatch');
      cacheResource(name, original);
    }
    let body = original;
    if (row.text) {
      const text = original.toString('utf8');
      if (!Buffer.from(text).equals(original) || text.split(TOKEN).length - 1 !== row.replacements || (name.endsWith('.html') && /\bintegrity\s*=/i.test(text))) throw new Error('Invalid mobile text resource');
      body = Buffer.from(text.replaceAll(TOKEN, mount.basePath));
    } else if (original.includes(Buffer.from(TOKEN))) throw new Error('Mobile mount token in binary resource');
    const extension = /\.[^.\/]+$/.exec(name)?.[0].toLowerCase();
    const htmlPolicy = name.endsWith('.html') ? {
      'content-security-policy': contentSecurityPolicy.replace(/(^|;\s*)script-src ([^;]*)/, (_match, lead, sources) => {
        const hashes = [...body.toString('utf8').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
          .filter(match => !/\bsrc\s*=/i.test(match[1]))
          .map(match => `'sha256-${createHash('sha256').update(match[2]).digest('base64')}'`);
        return `${lead}script-src ${sources} ${hashes.join(' ')}`;
      }),
    } : {};
    const cacheHeaders = name.endsWith('.html') ? htmlPolicy : {
      'cache-control': 'private, no-cache',
      vary: 'X-KCoder-Mobile-Mount',
      etag: `"${digest(JSON.stringify([DOMAIN, build.sha256, row.sha256, mount.basePath]))}"`,
    };
    if (cacheHeaders.etag && typeof request.headers['if-none-match'] === 'string' &&
        request.headers['if-none-match'].split(',').map(value => value.trim()).some(value => value === cacheHeaders.etag || value === `W/${cacheHeaders.etag}` || value === '*')) {
      response.writeHead(304, { ...cacheHeaders, 'x-content-type-options': 'nosniff' });
      response.end();
      return true;
    }
    send(response, 200, MIME[extension] ?? 'application/octet-stream', body, request.method, cacheHeaders);
    return true;
  };
}
