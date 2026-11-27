import { toNamespacedPath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

let uriSupported;
function requireUriSupport() {
  if (uriSupported === undefined) {
    // A read-only memory URI cannot create a filesystem entry when an older
    // Windows Node build treats URI syntax as a literal filename.
    try { const probe = new DatabaseSync('file::memory:', { readOnly: true }); probe.close(); uriSupported = true; }
    catch { uriSupported = false; }
  }
  if (!uriSupported) throw new Error('SQLITE_URI_UNSUPPORTED: use Node 22.17 or newer with SQLite URI support');
}

/** Keep SQLite's no-create mode and the exact Windows long-path namespace.
 * WHATWG file URLs remove the namespace; unencoded names can inject URI options. */
export function existingSqliteFileUri(path, mode) {
  if (mode !== 'ro' && mode !== 'rw') throw new TypeError('Invalid existing SQLite open mode');
  requireUriSupport();
  if (process.platform === 'win32') return `file:${encodeURIComponent(toNamespacedPath(path))}?mode=${mode}`;
  const uri = pathToFileURL(path);
  uri.searchParams.set('mode', mode);
  return uri.href;
}
