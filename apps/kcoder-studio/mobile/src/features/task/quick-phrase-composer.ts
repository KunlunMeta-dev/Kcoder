export function appendQuickPhraseToDraft(draft: string, content: string): string {
  if (!draft) return content;
  return `${draft}${draft.endsWith("\n") ? "" : "\n"}${content}`;
}
