const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function removeSpans(projection, pattern) {
  const chunks = [], offsets = []; let cursor = 0;
  for (const match of projection.text.matchAll(pattern)) {
    chunks.push(projection.text.slice(cursor, match.index));
    offsets.push(...projection.offsets.slice(cursor, match.index));
    cursor = match.index + match[0].length;
  }
  chunks.push(projection.text.slice(cursor)); offsets.push(...projection.offsets.slice(cursor));
  return { text: chunks.join(''), offsets };
}

/** Keep the existing visibility policy, but prove the address is one original
 * continuous span. Deleting code must never assemble a new @login. */
export function githubVisibleMention(value, login) {
  const body = String(value).slice(0, 32000);
  let projected = { text: body, offsets: Array.from({ length: body.length }, (_, index) => index) };
  projected = removeSpans(projected, /```[\s\S]*?(?:```|$)/g);
  projected = removeSpans(projected, /`[^`\n]*`/g);
  projected = removeSpans(projected, /^[^\S\n]*>[^\n]*(?:\n|$)/gm);
  const pattern = new RegExp('(^|[^A-Za-z0-9_/`-])@' + escape(login) + '(?![A-Za-z0-9_-])', 'gi');
  for (const match of projected.text.matchAll(pattern)) {
    const first = match.index + match[1].length, length = login.length + 1;
    const start = projected.offsets[first], end = start + length;
    let continuous = true;
    for (let index = 0; index < length; index++) if (projected.offsets[first + index] !== start + index) continuous = false;
    if (!continuous || body.slice(start, end).toLowerCase() !== '@' + login.toLowerCase()) continue;
    if (start > 0 && /[A-Za-z0-9_/`-]/.test(body[start - 1])) continue;
    if (/[A-Za-z0-9_-]/.test(body[end] ?? '')) continue;
    return { start, end };
  }
  return null;
}
