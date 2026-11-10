const reasons = new Set(['network_storage', 'reparse_point', 'owner_mismatch', 'acl_not_private', 'unsafe_file', 'identity_unavailable', 'validation_failed', 'store_busy']);
const unavailable = reason => Object.assign(new Error(`Private Windows mobile device storage unavailable (${reason})`), { code: 'MOBILE_DEVICE_STORAGE_UNAVAILABLE', reason });

/** One owned guard child. A lost receipt retires it; no request is replayed. */
export function createWindowsStorageGuardClient(child) {
  let retired = false, sequence = 0, bytes = Buffer.alloc(0);
  const pending = new Map();
  const reference = active => {
    for (const handle of [child, child.stdin, child.stdout, child.stderr]) handle?.[active ? 'ref' : 'unref']?.();
  };
  const retire = reason => {
    if (retired) return;
    retired = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(unavailable(reason)); }
    pending.clear(); bytes = Buffer.alloc(0);
    child.stdin.destroy(); child.kill(); reference(false);
  };
  child.once('error', error => retire(error.code === 'ENOENT' ? 'powershell_unavailable' : 'execution_failed'));
  child.once('exit', () => retire('execution_failed'));
  child.stdin.on('error', () => retire('execution_failed'));
  child.stdout.on('error', () => retire('execution_failed'));
  child.stderr.on('error', () => retire('execution_failed'));
  child.stdout.on('data', chunk => {
    if (retired) return;
    if (!Buffer.isBuffer(chunk) || bytes.length + chunk.length > 8192) { retire('output_limit'); return; }
    bytes = Buffer.concat([bytes, chunk]);
    let end;
    while (!retired && (end = bytes.indexOf(10)) >= 0) {
      const line = bytes.subarray(0, end); bytes = bytes.subarray(end + 1);
      const text = line.toString('utf8');
      if (text.includes('\\') || (text.match(/"id"\s*:/g) ?? []).length !== 1
        || (text.match(/"(?:identity|error)"\s*:/g) ?? []).length !== 1) { retire('invalid_identity'); return; }
      let value; try { value = JSON.parse(text); } catch { retire('invalid_identity'); return; }
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(value.id)
        || !pending.has(value.id) || Object.keys(value).length !== 2
        || !Object.hasOwn(value, 'id') || (Object.hasOwn(value, 'identity') === Object.hasOwn(value, 'error'))
        || (Object.hasOwn(value, 'identity') ? !/^[A-F0-9]{8}:[A-F0-9]{16}$/.test(value.identity)
          : !reasons.has(value.error))) { retire('invalid_identity'); return; }
      const request = pending.get(value.id); pending.delete(value.id); clearTimeout(request.timer);
      if (Object.hasOwn(value, 'error')) request.reject(unavailable(value.error));
      else request.resolve(`windows-volume-file:${value.identity}`);
      if (!pending.size) reference(false);
    }
  });
  let stderrBytes = 0;
  child.stderr.on('data', chunk => {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > 8192) retire('output_limit');
  });
  child.stdout.once('end', () => retire('execution_failed'));
  reference(false);
  return {
    check(path, initialize) {
      if (retired) return Promise.reject(unavailable('execution_failed'));
      if (typeof path !== 'string' || !path || path.length > 32767 || typeof initialize !== 'boolean'
        || pending.size >= 64 || sequence >= Number.MAX_SAFE_INTEGER) return Promise.reject(unavailable('validation_failed'));
      const id = ++sequence, line = JSON.stringify({ id, path, initialize }) + '\n';
      if (Buffer.byteLength(line) > 131072) return Promise.reject(unavailable('validation_failed'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => retire('timeout'), 10_000);
        pending.set(id, { resolve, reject, timer }); reference(true);
        child.stdin.write(line, error => { if (error) retire('execution_failed'); });
      });
    },
    close() { retire('execution_failed'); },
  };
}
