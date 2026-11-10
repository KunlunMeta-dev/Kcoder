import type { GatewayRpcClient } from "@/gateway/rpc";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { captureWorkspaceProfileIdentity, startWorkspaceProfileRpc, WorkspaceProfileFenceError } from "@/storage/workspace-profile-fence";
import { taskClientConnector } from "./connectionFactory";
import { clearWorkspaceOptionsCache, readWorkspaceSidebarOnClient } from "./workspaces";
import { projectNameValidation } from "@/protocol/project-display-name";

export interface ProjectRenameTarget { projectKey: string; rootProject: boolean; workspacePath: string }
export class ProjectRenameReconciliationError extends Error {
  constructor(readonly stage: string, cause: unknown, readonly reconciliationCause: unknown) {
    super("Project name could not be confirmed", { cause });
    this.name = "ProjectRenameReconciliationError";
  }
}

/** Rename only registered project display labels; directory paths and keys remain target-owned. */
export async function renameRuntimeProject(
  profile: GatewayProfile,
  server: KCoderServer,
  project: ProjectRenameTarget,
  input: string,
  isCurrent: () => boolean,
  canStart: () => boolean = isCurrent,
): Promise<{ name: string }> {
  const name = input.trim();
  if (projectNameValidation(name)) throw new Error("Project name is empty or too long");
  if (project.rootProject || !project.workspacePath || !project.projectKey) throw new Error("Only registered project labels can be renamed");
  const capturedProfile = { ...profile };
  const capturedServer = { ...server, ...(server.accountIdentity ? { accountIdentity: { ...server.accountIdentity } } : {}) };
  const authorization = captureWorkspaceProfileIdentity(capturedProfile);
  const assertCurrent = () => { if (!isCurrent()) throw new WorkspaceProfileFenceError(); };
  let client: GatewayRpcClient | undefined;
  let dispatched = false;
  let stage = "connect";
  const close = () => { const owned = client; client = undefined; try { owned?.close(); } catch { /* Cleanup must not replace the observed result. */ } };
  const read = async () => {
    assertCurrent();
    const sidebar = await readWorkspaceSidebarOnClient(client!, capturedServer);
    assertCurrent();
    const roots = sidebar.options.filter(option => option.projectKey === project.projectKey && option.rootProject !== true);
    if (!roots.length || !roots.every(option => (option.projectName ?? option.label) === name)) throw new Error("Project name could not be confirmed");
    return { name };
  };
  try {
    assertCurrent();
    if (!canStart()) throw new WorkspaceProfileFenceError();
    client = await taskClientConnector(capturedProfile, capturedServer, capturedServer.workspacePath, "runtime");
    assertCurrent();
    stage = "authorization";
    const started = await startWorkspaceProfileRpc(authorization, () => {
      assertCurrent();
      if (!canStart()) throw new WorkspaceProfileFenceError();
      dispatched = true; stage = "write";
      return client!.request<{ success?: boolean; accepted?: boolean }>("runtime.workspaces.rename", {
        deviceId: capturedServer.id, projectKey: project.projectKey, workspacePath: project.workspacePath, runtime: "kcoder", name,
      });
    });
    const receipt = await started.response;
    stage = "receipt";
    assertCurrent();
    if (receipt.success !== true || receipt.accepted !== true) throw new Error("Project rename receipt is missing");
    stage = "readback";
    return await read();
  } catch (error) {
    if (!dispatched || !isCurrent()) throw error;
    // A lost receipt can hide a committed rename. Reconnect once to read, never replay the write.
    close(); assertCurrent();
    try {
      client = await taskClientConnector(capturedProfile, capturedServer, capturedServer.workspacePath, "runtime");
      return await read();
    } catch (reconciliationError) {
      if (!isCurrent()) throw reconciliationError;
      throw new ProjectRenameReconciliationError(stage, error, reconciliationError);
    }
  } finally {
    close(); clearWorkspaceOptionsCache(capturedProfile.id);
  }
}
