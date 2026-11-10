import { isWebSourcesToolResultV1 } from "./generated/contractGuards.mjs";
import type { WebSourcesV1 as WireWebSourcesV1 } from "./generated/contracts.js";

export type WebSourcesV1 = WireWebSourcesV1 & {
  sources: NonNullable<WireWebSourcesV1["sources"]>;
  attempts: NonNullable<WireWebSourcesV1["attempts"]>;
};
type Binding = {
  threadId?: string;
  turnId?: string;
  attemptId?: string;
  toolCallId: string;
};

/** Only call with the dedicated native metadata field, never tool output or Markdown. */
export function normalizeWebSources(
  value: unknown,
  binding: Binding,
): WebSourcesV1 | undefined {
  const envelope = { webSources: value };
  if (!isWebSourcesToolResultV1(envelope) || !envelope.webSources)
    return undefined;
  const receipt = {
    ...envelope.webSources,
    sources: envelope.webSources.sources ?? [],
    attempts: envelope.webSources.attempts ?? [],
  };
  if (
    receipt.schemaVersion !== 1 ||
    receipt.toolCallId !== binding.toolCallId ||
    !receipt.toolCallId ||
    receipt.sources.length > 20 ||
    receipt.attempts.length > 3
  )
    return undefined;
  for (const field of ["threadId", "turnId", "attemptId"] as const) {
    const id = receipt.identity[field];
    if (
      !id ||
      id.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(id) ||
      (binding[field] !== undefined && binding[field] !== id)
    )
      return undefined;
  }
  const ids = new Set<string>();
  for (const page of receipt.sources) {
    if (
      !page.sourceId ||
      page.sourceId.length > 128 ||
      ids.has(page.sourceId) ||
      page.title.length > 1024 ||
      page.url.length > 8192 ||
      !safeWebSourceUrl(page.url) ||
      page.retrievedAt.length > 128 ||
      (page.publishedAt?.length ?? 0) > 128 ||
      (page.author?.length ?? 0) > 512
    )
      return undefined;
    ids.add(page.sourceId);
  }
  return receipt;
}

export function safeWebSourceUrl(value: string): boolean {
  if (!/^https?:\/\//iu.test(value) || /[\s\u0000-\u001f\u007f\\]/u.test(value))
    return false;
  const authority = value.slice(value.indexOf('://') + 3).split(/[/?#]/u)[0]
  if (authority.includes('@')) return false
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Presentation only: keep unknown values and the native observation itself unchanged. */
export function formatWebSourceRetrievedAt(raw: string, locale: string): string {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(raw)) return raw
  const date = new Date(raw)
  if (!Number.isFinite(date.getTime())) return raw
  try {
    return date.toLocaleString(locale, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
  } catch { return raw }
}
