function normalizeWindowsSeparators(value: string): string {
  const converted = value.replace(/\//g, "\\");
  const hasUncPrefix = converted.startsWith("\\\\");
  const body = converted.slice(hasUncPrefix ? 2 : 0).replace(/\\+/g, "\\");
  return hasUncPrefix ? `\\\\${body}` : body;
}

export function isWindowsAbsoluteWorkspacePath(value: string): boolean {
  const normalized = normalizeWindowsSeparators(value);
  return /^[A-Za-z]:\\/.test(normalized) || /^\\\\[^\\]+\\[^\\]+(?:\\.*)?$/.test(normalized);
}

export function isAbsoluteWorkspacePath(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsoluteWorkspacePath(value);
}

export function relativeWorkspacePath(root: string, candidate: string): string | null {
  if (isWindowsAbsoluteWorkspacePath(root)) {
    if (!isWindowsAbsoluteWorkspacePath(candidate)) return null;
    const rootParts = normalizeWindowsSeparators(root).replace(/\\+$/, "").split("\\");
    const candidateParts = normalizeWindowsSeparators(candidate).replace(/\\+$/, "").split("\\");
    if (
      candidateParts.length < rootParts.length ||
      rootParts.some((part, index) => part.toLowerCase() !== candidateParts[index]?.toLowerCase())
    ) return null;
    return candidateParts.slice(rootParts.length).join("/");
  }
  if (root === "/") return candidate.startsWith("/") ? candidate.slice(1) : null;
  if (candidate === root) return "";
  return candidate.startsWith(`${root}/`) ? candidate.slice(root.length + 1) : null;
}

export function isWorkspacePath(root: string, candidate: string): boolean {
  if (safeWorkspacePathRelative(root, candidate, true) !== null) return true;
  const withoutTrailingSeparators = candidate.replace(/[\\/]+$/, "");
  return withoutTrailingSeparators !== candidate &&
    withoutTrailingSeparators.length > 0 &&
    safeWorkspacePathRelative(root, withoutTrailingSeparators, true) !== null;
}

export function safeWorkspacePathRelative(
  root: string,
  candidate: string,
  allowRoot = false,
): string | null {
  const relative = relativeWorkspacePath(root, candidate);
  if (
    relative === null ||
    candidate.length > 4096 ||
    /\p{Cc}/u.test(candidate)
  ) return null;
  if (relative === "") return allowRoot ? "" : null;
  if (candidate.endsWith("/") || (isWindowsAbsoluteWorkspacePath(root) && candidate.endsWith("\\"))) return null;
  if (!isWindowsAbsoluteWorkspacePath(root) && relative.includes("\\")) return null;
  return relative.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
    ? relative
    : null;
}

export function joinWorkspacePath(root: string, relative: string): string {
  if (isWindowsAbsoluteWorkspacePath(root)) {
    const separator = root.includes("\\") ? "\\" : "/";
    const suffix = relative.replace(/^[\\/]+/, "").replace(/[\\/]/g, separator);
    if (!suffix) return root;
    const base = root.replace(/[\\/]+$/, "");
    return `${base}${separator}${suffix}`;
  }
  const suffix = relative.replace(/^\/+/, "");
  if (!suffix) return root;
  return root === "/" ? `/${suffix}` : `${root}/${suffix}`;
}

export function workspaceRelativePath(root: string, candidate: string): string {
  return safeWorkspacePathRelative(root, candidate, true) ?? "";
}

export function workspacePathName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.slice(Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\")) + 1);
}

export function workspacePathParent(root: string, candidate: string): string {
  const relative = relativeWorkspacePath(root, candidate);
  if (relative === null || relative === "") return root;
  const segments = relative.split("/");
  segments.pop();
  return segments.length ? joinWorkspacePath(root, segments.join("/")) : root;
}
