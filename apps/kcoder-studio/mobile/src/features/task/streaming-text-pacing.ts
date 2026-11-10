/** Display-only budgets, measured in UTF-16 units rather than model tokens. */
export const TEXT_PACING = { immediate: 128, tickMs: 24, maxLagMs: 160, maxBacklog: 4096, maxAnimatedLength: 32768 } as const;

export function mustShowFullText(text: string, shown: string, live: boolean, ageMs: number): boolean {
  const backlog = text.length - shown.length;
  return !live || text.length >= TEXT_PACING.maxAnimatedLength || !text.startsWith(shown) || backlog <= TEXT_PACING.immediate ||
    backlog >= TEXT_PACING.maxBacklog || ageMs >= TEXT_PACING.maxLagMs;
}

export function pacedTextStep(text: string, shown: string): string {
  const backlog = text.length - shown.length;
  const step = Math.min(512, Math.max(32, Math.ceil(backlog / 4)));
  return text.slice(0, safeDisplayEnd(text, shown.length + step));
}

/** Keep surrogate pairs, combining marks, emoji modifiers/ZWJ chains and flag pairs together. */
export function safeDisplayEnd(text: string, requested: number): number {
  let end = Math.min(text.length, requested);
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end++;
  while (end < text.length) {
    const next = text.codePointAt(end)!;
    const previous = text.charCodeAt(end - 1);
    if (/\p{Mark}/u.test(String.fromCodePoint(next)) || next === 0xFE0F ||
        next >= 0x1F3FB && next <= 0x1F3FF || next === 0x200D || previous === 0x200D) {
      end += next > 0xFFFF ? 2 : 1;
      continue;
    }
    if (next >= 0x1F1E6 && next <= 0x1F1FF) {
      let count = 0;
      for (let start = end - 2; start >= 0; start -= 2) {
        const point = text.codePointAt(start)!;
        if (point < 0x1F1E6 || point > 0x1F1FF) break;
        count++;
      }
      if (count % 2) { end += 2; continue; }
    }
    break;
  }
  return end;
}
