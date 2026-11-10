/** A presentation-only fallback: never loads an artifact or changes stored text. */
export function inlineWidgetFallback(content: string, hint: string): string {
  let fence: { marker: string; length: number } | undefined;
  return content.split("\n").map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = { marker: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return line;
    }
    if (fence) return line;
    const directive = line.match(/^ {0,3}::kcoder-widget\{\s*widget_id="([A-Za-z0-9_-]{1,128})"\s+revision=([1-9]\d{0,14})\s*\}[ \t\r]*$/);
    return directive && Number.isSafeInteger(Number(directive[2])) ? `> ${hint}` : line;
  }).join("\n");
}
