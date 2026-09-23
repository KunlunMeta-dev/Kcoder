function normalizeAbsolutePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
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
  const root = normalizeAbsolutePath(workspaceRoot);
  let value = rawLink.trim();
  if (!value || value.startsWith("#")) return null;
  const supportedAbsoluteScheme = /^(?:file:\/\/|vscode:\/\/file\/)/i.test(value);
  const valueWithoutColonLocation = value.replace(/:\d+(?::\d+)?$/, "");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(valueWithoutColonLocation) && !supportedAbsoluteScheme) return null;
  try {
    if (/^file:\/\//i.test(value)) value = decodeURIComponent(new URL(value).pathname);
    else if (/^vscode:\/\/file\//i.test(value)) value = decodeURIComponent(value.replace(/^vscode:\/\/file/i, ""));
    else value = decodeURIComponent(value);
  } catch {
    return null;
  }
  value = value.split("?")[0] ?? value;
  const hashLocation = value.match(/#L(\d+)(?:-L\d+)?$/i);
  const colonLocation = hashLocation ? null : value.match(/:(\d+)(?::(\d+))?$/);
  const line = Number(hashLocation?.[1] ?? colonLocation?.[1] ?? 0) || undefined;
  const column = Number(colonLocation?.[2] ?? 0) || undefined;
  value = withoutLocationSuffix(value);
  const path = normalizeAbsolutePath(value.startsWith("/") ? value : `${root}/${value}`);
  if (path === root || (root !== "/" && !path.startsWith(`${root}/`))) return null;
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
    || candidate.startsWith("./")
    || candidate.startsWith("../")
    || candidate.includes("/")
    || /(?:^|\/)[^/]+\.[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/.test(candidate);
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
