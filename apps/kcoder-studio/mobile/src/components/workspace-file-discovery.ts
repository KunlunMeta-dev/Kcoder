import type { TaskRuntime } from "@/runtime/task-runtime";
import { joinWorkspacePath, safeWorkspacePathRelative } from "./workspace-path";

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  is_directory: boolean;
  size?: number;
}

const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_QUERY_BYTES = 256;
const MAX_RECENT_FILES = 20;

export class WorkspaceSearchQueryTooLongError extends Error {
  constructor() {
    super("workspace search query is too long");
    this.name = "WorkspaceSearchQueryTooLongError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isSafeRelativePath(value: string): boolean {
  if (
    !value ||
    value.length > 4096 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /\p{Cc}/u.test(value)
  )
    return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function workspaceSearchQueryByteLength(value: string): number {
  let length = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    length +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return length;
}

export function parseWorkspacePathSearchResult(
  root: string,
  value: unknown,
): WorkspaceFileEntry[] {
  const payload = record(value);
  if (!payload || !Array.isArray(payload.files)) return [];
  const seen = new Set<string>();
  const results: WorkspaceFileEntry[] = [];
  for (const value of payload.files) {
    const item = record(value);
    if (
      !item ||
      typeof item.path !== "string" ||
      !isSafeRelativePath(item.path) ||
      (item.matchType !== "file" && item.matchType !== "directory")
    )
      continue;
    const path = joinWorkspacePath(root, item.path);
    if (safeWorkspacePathRelative(root, path) === null || seen.has(path)) continue;
    seen.add(path);
    results.push({
      path,
      name: item.path.split("/").at(-1) ?? item.path,
      is_directory: item.matchType === "directory",
    });
    if (results.length >= MAX_SEARCH_RESULTS) break;
  }
  return results;
}

export async function searchWorkspacePaths(
  task: TaskRuntime,
  root: string,
  query: string,
): Promise<WorkspaceFileEntry[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  if (workspaceSearchQueryByteLength(normalizedQuery) > MAX_SEARCH_QUERY_BYTES) {
    throw new WorkspaceSearchQueryTooLongError();
  }
  const response = await task.request<unknown>("runtime.workspace.search", {
    root,
    query: normalizedQuery,
  });
  return parseWorkspacePathSearchResult(root, response);
}

export function workspaceRecentFilesForRoot(
  root: string,
  recentFiles: readonly string[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of recentFiles) {
    if (
      typeof path !== "string" ||
      path.length > 4096 ||
      safeWorkspacePathRelative(root, path) === null ||
      seen.has(path)
    )
      continue;
    seen.add(path);
    result.push(path);
    if (result.length >= MAX_RECENT_FILES) break;
  }
  return result;
}

export function rememberWorkspaceFile(
  root: string,
  recentFiles: readonly string[],
  path: string,
): string[] {
  if (
    path.length > 4096 ||
    safeWorkspacePathRelative(root, path) === null
  ) {
    return workspaceRecentFilesForRoot(root, recentFiles);
  }
  return workspaceRecentFilesForRoot(root, [path, ...recentFiles]);
}

export async function rememberWorkspaceFileAfterPersistence(
  root: string,
  path: string,
  persist: (path: string) => Promise<readonly string[]> | readonly string[],
): Promise<string[]> {
  const persisted = await persist(path);
  return workspaceRecentFilesForRoot(root, persisted);
}
