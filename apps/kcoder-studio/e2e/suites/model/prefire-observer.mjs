// Keep only numeric transport observations and fixed lifecycle flags from live stderr.
export function createPrefireObserver() {
  let pending = '', completed = false, failed = false, covered = 0;
  const attempts = [];
  return {
    consume(chunk) {
      pending += String(chunk);
      const lines = pending.split('\n');
      pending = lines.pop().slice(-65536);
      for (const line of lines) {
        const completion = line.match(/kcoder_engine::compaction_runtime: background prefire compaction completed: ([1-9]\d*) messages/);
        if (completion) { completed = true; covered = Number(completion[1]); }
        if (line.includes('kcoder_engine::compaction_runtime: background prefire compaction failed')) failed = true;
        if (!line.includes('kcoder::transport_metrics: provider transport attempt')) continue;
        if (attempts.length >= 16) { failed = true; continue; }
        const number = field => {
          const match = line.match(new RegExp(`\\b${field}=(?:Some\\()?([0-9]+)`));
          return match ? Number(match[1]) : null;
        };
        attempts.push({ status: number('status'), bodyBytes: number('request_body_bytes'),
          elapsedUs: number('elapsed_us'), firstTextUs: number('first_text_us'),
          input: number('input_tokens'), output: number('output_tokens'),
          cacheRead: number('cache_read_tokens'), cacheCreation: number('cache_creation_tokens') });
      }
    },
    snapshot() { return { completed, failed, covered, attempts: attempts.map(item => ({ ...item })) }; },
  };
}

export function diagnoseRecall(text, marker) {
  let value;
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  try { value = JSON.parse(fence ? fence[1] : trimmed); } catch { return { jsonParsed: false, schemaValid: false }; }
  const schemaValid = value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 2 && Object.hasOwn(value, 'filename') && Object.hasOwn(value, 'can_delete')
    && (value.filename === null || typeof value.filename === 'string')
    && (value.can_delete === null || typeof value.can_delete === 'boolean');
  return { jsonParsed: true, schemaValid, filenameExactMatch: schemaValid && value.filename === marker,
    canDeleteIsFalse: schemaValid && value.can_delete === false,
    unknownFilename: schemaValid && value.filename === null, unknownPermission: schemaValid && value.can_delete === null };
}

export function diagnoseCompactionMarker(records, marker) {
  const boundaryIndex = records.findLastIndex(record => record.subtype === 'compact_boundary');
  const boundary = records[boundaryIndex];
  const segment = boundary?.compactMetadata?.preservedSegment;
  const automatic = boundary?.compactMetadata?.trigger === 'auto';
  const summary = automatic && segment && records.slice(boundaryIndex + 1).find(record => record.isCompactSummary === true
    && record.parentUuid === boundary.uuid && record.uuid === segment.anchorUuid);
  const head = segment ? records.findIndex(record => record.uuid === segment.headUuid) : -1;
  const tail = segment ? records.findIndex(record => record.uuid === segment.tailUuid) : -1;
  return { boundaryFound: Boolean(boundary), summaryMarker: summary ? JSON.stringify(summary.content).includes(marker) : null,
    tailMarker: automatic && head >= 0 && tail >= head && tail < boundaryIndex
      ? JSON.stringify(records.slice(head, tail + 1)).includes(marker) : null };
}
