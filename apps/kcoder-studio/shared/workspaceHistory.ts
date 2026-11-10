/** Presentation membership only; never remap a history cwd or authorize filesystem access. */
export function isRegisteredHistoryWorkspace(
  cwd: string,
  projectPaths: Iterable<string>,
  pathKey: (path: string) => string,
): boolean {
  const key = pathKey(cwd);
  for (const path of projectPaths) if (pathKey(path) === key) return true;
  return false;
}
