import {
  isWindowsAbsoluteWorkspacePath,
  joinWorkspacePath,
  safeWorkspacePathRelative,
} from "./workspace-path";

function normalizeUrlPath(value: string, workspaceRoot: string): string {
  if (!isWindowsAbsoluteWorkspacePath(workspaceRoot)) return value;
  if (/^\/[A-Za-z]:\//.test(value)) return value.slice(1).replace(/\//g, "\\");
  if (value.startsWith("//")) return `\\\\${value.slice(2).replace(/\//g, "\\")}`;
  return value;
}

function decodeSupportedFileUrl(value: string, workspaceRoot: string): string | null {
  try {
    const url = new URL(value);
    const pathname = decodeURIComponent(url.pathname);
    const lineFragment = /^#L\d+(?:-L\d+)?$/i.test(url.hash) ? url.hash : "";
    if (url.protocol === "file:") {
      if (url.hostname && url.hostname.toLowerCase() !== "localhost") {
        return `\\\\${url.hostname}${pathname.replace(/\//g, "\\")}${lineFragment}`;
      }
      return `${normalizeUrlPath(pathname, workspaceRoot)}${lineFragment}`;
    }
    if (url.protocol === "vscode:" && url.hostname.toLowerCase() === "file") {
      return `${normalizeUrlPath(pathname, workspaceRoot)}${lineFragment}`;
    }
    return null;
  } catch {
    return null;
  }
}

function withoutLocationSuffix(value: string): string {
  return value.replace(/#L\d+(?:-L\d+)?$/i, "").replace(/:\d+(?::\d+)?$/, "");
}

export interface WorkspaceFileLocation {
  path: string;
  line?: number;
  column?: number;
}

export function workspaceFileLocationFromLink(rawLink: string, workspaceRoot: string): WorkspaceFileLocation | null {
  let value = rawLink.trim();
  if (!value || value.startsWith("#")) return null;
  const supportedAbsoluteScheme = /^(?:file:\/\/|vscode:\/\/file\/)/i.test(value);
  const valueWithoutColonLocation = value.replace(/:\d+(?::\d+)?$/, "");
  const isWindowsPath = isWindowsAbsoluteWorkspacePath(valueWithoutColonLocation);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(valueWithoutColonLocation) && !supportedAbsoluteScheme && !isWindowsPath) return null;
  if (supportedAbsoluteScheme) {
    const decoded = decodeSupportedFileUrl(value, workspaceRoot);
    if (decoded === null) return null;
    value = decoded;
  } else {
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  value = value.split("?")[0] ?? value;
  const hashLocation = value.match(/#L(\d+)(?:-L\d+)?$/i);
  const colonLocation = hashLocation ? null : value.match(/:(\d+)(?::(\d+))?$/);
  const line = Number(hashLocation?.[1] ?? colonLocation?.[1] ?? 0) || undefined;
  const column = Number(colonLocation?.[2] ?? 0) || undefined;
  value = withoutLocationSuffix(value);
  if (/^\/[A-Za-z]:\//.test(value) && isWindowsAbsoluteWorkspacePath(workspaceRoot)) {
    value = value.slice(1).replace(/\//g, "\\");
  } else if (value.startsWith("//") && isWindowsAbsoluteWorkspacePath(workspaceRoot)) {
    value = `\\\\${value.slice(2).replace(/\//g, "\\")}`;
  }
  const candidate = isWindowsAbsoluteWorkspacePath(value) || value.startsWith("/")
    ? value
    : joinWorkspacePath(workspaceRoot, value);
  const relative = safeWorkspacePathRelative(workspaceRoot, candidate);
  if (relative === null) return null;
  const path = joinWorkspacePath(workspaceRoot, relative);
  return { path, line, column };
}

export function workspaceFilePathFromLink(rawLink: string, workspaceRoot: string): string | null {
  return workspaceFileLocationFromLink(rawLink, workspaceRoot)?.path ?? null;
}

export function workspaceFilePathFromInlineCode(rawValue: string, workspaceRoot: string): string | null {
  const value = rawValue.trim();
  if (!value || value.length > 512 || /\s/.test(value)) return null;
  const candidate = withoutLocationSuffix(value.split("?", 1)[0] ?? value);
  const looksLikePath = candidate.startsWith("/")
    || isWindowsAbsoluteWorkspacePath(candidate)
    || candidate.startsWith("./")
    || candidate.startsWith("../")
    || candidate.startsWith(".\\")
    || candidate.startsWith("..\\")
    || /[\\/]/.test(candidate)
    || /(?:^|[\\/])[^\\/]+\.[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/.test(candidate);
  return looksLikePath ? workspaceFilePathFromLink(value, workspaceRoot) : null;
}

export function isWorkspaceFileConflictError(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value ?? "");
  return /(?:changed on disk|revision|version conflict|版本冲突|文件已变化)/i.test(message);
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

export function workspaceImageMimeType(filename: string): string | null {
  const extension = filename.toLocaleLowerCase().split(".").at(-1) ?? "";
  return IMAGE_MIME_TYPES[extension] ?? null;
}
