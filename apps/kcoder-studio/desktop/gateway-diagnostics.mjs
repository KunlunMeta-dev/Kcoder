/** Redact this owner's known credential without delaying complete diagnostic lines. */
export function createGatewayDiagnostics({ token, onStdout, onStderr }) {
  const secrets = [...new Set([token, encodeURIComponent(token), new URLSearchParams({ token }).toString().slice(6)])]
    .sort((left, right) => right.length - left.length);
  const tail = Math.max(...secrets.map(value => value.length)) - 1;
  const redact = value => secrets.reduce((result, secret) => result.split(secret).join('[redacted]'), value);
  const stream = emit => {
    let pending = '', failed = false, recent = '';
    const take = end => {
      let cursor = 0, output = '';
      while (cursor < end) {
        let found = -1, secret;
        for (const candidate of secrets) {
          const index = pending.indexOf(candidate, cursor);
          if (index >= 0 && (found < 0 || index < found)) { found = index; secret = candidate; }
        }
        if (found < 0 || found >= end) { output += pending.slice(cursor, end); cursor = end; break; }
        output += pending.slice(cursor, found) + '[redacted]'; cursor = found + secret.length;
      }
      pending = pending.slice(cursor);
      if (!output || failed) return;
      recent = (recent + output).slice(-512 * 1024);
      try { Promise.resolve(emit?.(output)).catch(() => { failed = true; }); }
      catch { failed = true; }
    };
    return {
      write(chunk) {
        if (failed) return;
        pending += chunk;
        const newline = pending.lastIndexOf('\n');
        if (newline >= 0) take(newline + 1);
        if (pending.length > 16_384) take(pending.length - tail);
      },
      flush() { take(pending.length); },
      snapshot() { return recent; },
    };
  };
  return { stdout: stream(onStdout), stderr: stream(onStderr), redact };
}
