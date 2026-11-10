export type TargetBrowserUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: "empty" | "invalid" | "unsupported-scheme" | "credentials" };

/** Accept only navigable HTTP(S) URLs and never forward embedded credentials to a target. */
export function normalizeTargetBrowserUrl(input: string): TargetBrowserUrlResult {
  const value = input.trim();
  if (!value) return { ok: false, reason: "empty" };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "unsupported-scheme" };
  }
  if (!parsed.hostname) return { ok: false, reason: "invalid" };
  if (parsed.username || parsed.password) return { ok: false, reason: "credentials" };
  return { ok: true, url: parsed.toString() };
}
