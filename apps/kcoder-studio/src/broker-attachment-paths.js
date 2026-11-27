/** Decode only the attachment paths referenced by this original turn. */
export function attachmentPathsFromTurn(request) {
  const open = '<kcoder_attachments version="1">\n';
  const close = '\n</kcoder_attachments>';
  const paths = [];
  // Match the Native input field: steer owns text; turn/start prefers prompt,
  // otherwise joining input.text with Unicode White_Space trimming (not BOM).
  const params = request.params ?? {};
  const prompt = request.method === 'turn/steer' ? (typeof params.text === 'string' ? params.text : '')
    : typeof params.prompt === 'string' ? params.prompt
    : (Array.isArray(params.input) ? params.input : [])
      .map(item => item?.text).filter(value => typeof value === 'string')
      .join('\n').replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
  const openIndex = prompt.lastIndexOf(open);
  if (openIndex < 0 || !prompt.endsWith(close)) return paths;
  const bodyStart = openIndex + open.length;
  const bodyEnd = prompt.length - close.length;
  for (const line of prompt.slice(bodyStart, bodyEnd).split(/\r?\n/)) {
    try {
      const record = JSON.parse(line);
      if (typeof record?.path === 'string') paths.push(record.path);
    } catch {
      // The app-server owns validation errors for malformed envelopes.
    }
  }
  return paths;
}
