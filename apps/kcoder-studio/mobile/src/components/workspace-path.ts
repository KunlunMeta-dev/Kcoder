export function isWorkspacePath(root: string, candidate: string): boolean {
  if (root === "/") return candidate.startsWith("/");
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function joinWorkspacePath(root: string, relative: string): string {
  const suffix = relative.replace(/^\/+/, "");
  if (!suffix) return root;
  return root === "/" ? `/${suffix}` : `${root}/${suffix}`;
}

export function workspaceRelativePath(root: string, candidate: string): string {
  if (candidate === root || !isWorkspacePath(root, candidate)) return "";
  return root === "/" ? candidate.slice(1) : candidate.slice(root.length + 1);
}
