import type { KCoderServer } from "./types";

export type ThreadMutationServer = Pick<KCoderServer, "id"> &
  Partial<
    Pick<
      KCoderServer,
      | "transport"
      | "host"
      | "user"
      | "port"
      | "command"
      | "profile"
      | "settingsFile"
      | "accountIdentity"
    >
  >;

export function threadMutationServerIdentity(
  server: ThreadMutationServer,
): string {
  return JSON.stringify([
    server.id,
    server.transport,
    server.host,
    server.user,
    server.port,
    server.command,
    server.profile,
    server.settingsFile,
    ...(server.accountIdentity ? [server.accountIdentity.principalId, server.accountIdentity.role] : []),
  ]);
}

/** Include route and target revisions when an interaction is bound to a server. */
export function interactionServerIdentity(server: KCoderServer): string {
  return JSON.stringify([
    threadMutationServerIdentity(server),
    server.accountIdentity?.username ?? null,
    server.observationTargetIdentity ?? null,
  ]);
}

export function workspaceThreadScopeIdentity(path: string | undefined): string {
  if (path === undefined) return "\u0000default";
  if (/^[A-Za-z]:[\\/]+$/.test(path)) return `${path.slice(0, 2)}\\`;
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed || (path.startsWith("\\") ? "\\" : "/");
}

export function workspaceThreadScopeServers(
  server: KCoderServer,
  options: readonly { path: string }[],
): KCoderServer[] {
  const paths = new Map<string, string | undefined>();
  const addPath = (path: string | undefined) => {
    const identity = workspaceThreadScopeIdentity(path);
    if (!paths.has(identity)) paths.set(identity, path);
  };
  addPath(server.workspacePath);
  for (const option of options) addPath(option.path);
  if (paths.size === 0) addPath(undefined);
  return [...paths.values()].map((workspacePath) => ({
    ...server,
    workspacePath,
  }));
}
