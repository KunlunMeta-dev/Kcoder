const allowed = new Set(['history_unavailable', 'profile_unavailable', 'profile_changed', 'cursor_stale',
  'params_invalid', 'metadata_unavailable', 'factory_paths', 'profile_capture', 'storage_read']);

/** The test observer retains only the Native producer's fixed class, never its line. */
export function lookupDiagnosticCodes(emit) {
  let buffer = '';
  return chunk => {
    buffer = (buffer + String(chunk)).slice(-8192);
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) return;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.includes('Native workspace lookup refused')) continue;
      const code = line.match(/code="?([a-z_]+)"?(?:\s|$)/)?.[1];
      if (allowed.has(code)) emit(code);
    }
  };
}
