/** The workspace registry limits display names to 256 UTF-8 bytes after trimming. */
export function projectNameValidation(name: string): "empty" | "too_long" | null {
  const trimmed = name.trim();
  if (!trimmed) return "empty";
  return new TextEncoder().encode(trimmed).byteLength > 256 ? "too_long" : null;
}
