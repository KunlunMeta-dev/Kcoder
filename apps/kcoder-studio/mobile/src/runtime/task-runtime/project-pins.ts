import type { GatewayRpcClient } from "@/gateway/rpc";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { interactionServerIdentity } from "@/gateway/target-identity";
import { captureWorkspaceProfileIdentity, startWorkspaceProfileRpc, WorkspaceProfileFenceError } from "@/storage/workspace-profile-fence";
import { taskClientConnector } from "./connectionFactory";
import { clearWorkspaceOptionsCache, readWorkspaceSidebarOnClient, type WorkspaceOption } from "./workspaces";

export interface ProjectPinConfirmation {
  pinned: boolean;
  pinnedOrder?: number;
  workspaces: WorkspaceOption[];
}

export interface ProjectPinTarget {
  projectKey: string;
  rootProject: boolean;
}

type ProjectPinStage = "connect" | "authorization" | "write" | "receipt" | "readback";

export class ProjectPinReconciliationError extends Error {
  constructor(readonly stage: ProjectPinStage, cause: unknown, readonly reconciliationCause: unknown) {
    super("Project pin state could not be confirmed", { cause });
    this.name = "ProjectPinReconciliationError";
  }
}

/** Store sidebar pins on the target app-server and verify them from its workspace registry. */
export async function setRuntimeProjectPinned(
  profile: GatewayProfile,
  server: KCoderServer,
  project: ProjectPinTarget,
  pinned: boolean,
  isCurrent: () => boolean,
  canStart: () => boolean = isCurrent,
): Promise<ProjectPinConfirmation> {
  const capturedProfile = { ...profile };
  const capturedServer = { ...server, ...(server.accountIdentity ? { accountIdentity: { ...server.accountIdentity } } : {}) };
  const authorization = captureWorkspaceProfileIdentity(capturedProfile);
  const targetIdentity = interactionServerIdentity(server);
  const workspacePath = server.workspacePath;
  const ownerIsCurrent = () => isCurrent() && interactionServerIdentity(server) === targetIdentity && server.workspacePath === workspacePath;
  const assertCurrent = () => { if (!ownerIsCurrent()) throw new WorkspaceProfileFenceError(); };
  const { projectKey, rootProject } = project;
  let client: GatewayRpcClient | undefined;
  let dispatched = false;
  let stage: ProjectPinStage = "connect";
  const close = () => { const owned = client; client = undefined; try { owned?.close(); } catch { /* Keep the observed result authoritative. */ } };
  const read = async (): Promise<ProjectPinConfirmation> => {
    assertCurrent();
    const sidebar = await readWorkspaceSidebarOnClient(client!, capturedServer);
    assertCurrent();
    const observed = sidebar.options.find(option => option.projectKey === projectKey && option.rootProject === rootProject && typeof option.projectPinned === "boolean");
    const observedPin = rootProject ? sidebar.rootProjectPinned : observed?.projectPinned;
    if (observedPin !== pinned) throw new Error("Project pin state could not be confirmed");
    return {
      pinned: observedPin,
      ...(observed?.projectPinnedOrder !== undefined ? { pinnedOrder: observed.projectPinnedOrder } : {}),
      workspaces: sidebar.options,
    };
  };
  try {
    assertCurrent();
    if (!canStart()) throw new WorkspaceProfileFenceError();
    client = await taskClientConnector(capturedProfile, capturedServer, workspacePath, "runtime");
    assertCurrent();
    if (rootProject && (!capturedServer.workspacePath || client.supportsExperimental?.("sidebarRootPinning") !== true))
      throw new Error("Target does not support root project pinning");
    stage = "authorization";
    const started = await startWorkspaceProfileRpc(authorization, () => {
      assertCurrent();
      if (!canStart()) throw new WorkspaceProfileFenceError();
      dispatched = true;
      stage = "write";
      return client!.request<{ success?: boolean; accepted?: boolean }>("runtime.sidebar.projects.pin", {
        deviceId: capturedServer.id,
        projectKey: rootProject ? capturedServer.workspacePath! : projectKey,
        pinned,
        ...(rootProject ? { rootProject: true } : {}),
      });
    });
    const receipt = await started.response;
    stage = "receipt";
    assertCurrent();
    if (receipt.success !== true || receipt.accepted !== true) throw new Error("Project pin receipt is missing");
    stage = "readback";
    return await read();
  } catch (error) {
    if (!dispatched || !ownerIsCurrent()) throw error;
    // A lost receipt may hide a committed write. Reconnect only to read; never replay the mutation.
    close();
    assertCurrent();
    try {
      client = await taskClientConnector(capturedProfile, capturedServer, workspacePath, "runtime");
      return await read();
    } catch (reconciliationError) {
      if (!ownerIsCurrent()) throw reconciliationError;
      throw new ProjectPinReconciliationError(stage, error, reconciliationError);
    }
  } finally {
    close();
    clearWorkspaceOptionsCache(capturedProfile.id);
  }
}
