import { metadataStorage } from "@/storage/metadata-authority";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SettingsHistoryViewOwners } from './settings-history-view-owners';
import {
  GatewayRpcClient,
  MobileRpcError,
  type GatewayConnectOptions,
  type GatewayServerCapabilities,
  type JsonRecord,
} from "@/gateway/rpc";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import {
  captureWorkspaceProfileIdentity,
  startWorkspaceProfileRpc,
  withWorkspaceProfileMetadata,
  WorkspaceProfileFenceError,
  type WorkspaceProfileIdentity,
} from "@/storage/workspace-profile-fence";

export type SettingsTargetRpcChannel = "runtime" | "browser";

export interface SettingsTargetCapabilities {
  /** Capabilities advertised for this target in the Gateway server inventory. */
  readonly gateway: Readonly<Record<string, boolean>>;
  /** Capabilities returned by the app-server initialize handshake. */
  readonly appServer: GatewayServerCapabilities | null;
}

export interface SettingsTargetRpcClient {
  request<T = unknown>(method: string, params?: JsonRecord): Promise<T>;
  close(): void;
  subscribeClose(listener: () => void): () => void;
  getCapabilities(): GatewayServerCapabilities | undefined;
}

export interface SettingsTargetSessionCloseEvent {
  readonly channel: SettingsTargetRpcChannel;
}

export type SettingsTargetConnector = (
  profile: GatewayProfile,
  server: KCoderServer,
  workspacePath: string | undefined,
  channel: SettingsTargetRpcChannel,
  options: GatewayConnectOptions,
) => Promise<SettingsTargetRpcClient>;

export type SettingsTargetProfileRpc = <T>(
  identity: WorkspaceProfileIdentity,
  send: () => Promise<T>,
) => Promise<{ response: Promise<T> }>;

export interface SettingsTargetSessionDependencies {
  connect: SettingsTargetConnector;
  profileRpc: SettingsTargetProfileRpc;
}

const LOCAL_SELECTION_PREFIX = "kcoder-studio:mobile-settings-target:v1:";

const defaultDependencies: SettingsTargetSessionDependencies = {
  // GatewayRpcClient performs the existing Gateway authorization and initialize handshake.
  connect: (profile, server, workspacePath, channel, options) =>
    GatewayRpcClient.connect(profile, server, workspacePath, channel, options),
  profileRpc: startWorkspaceProfileRpc,
};

export class SettingsTargetChangedError extends Error {
  readonly code = "SETTINGS_TARGET_CHANGED";

  constructor(readonly delivery: "not-sent" | "unknown") {
    super("SETTINGS_TARGET_CHANGED");
    this.name = "SettingsTargetChangedError";
  }
}

export class SettingsTargetUnavailableError extends Error {
  readonly code = "SETTINGS_TARGET_UNAVAILABLE";

  constructor() {
    super("SETTINGS_TARGET_UNAVAILABLE");
    this.name = "SettingsTargetUnavailableError";
  }
}

function profileScope(profile: GatewayProfile): string {
  return JSON.stringify([
    profile.id,
    profile.baseUrl,
    profile.authorizationGeneration ?? "legacy:" + profile.id,
    profile.deviceId ?? null,
  ]);
}

/** Non-secret identity for a saved local target choice; it is not server configuration. */
export function settingsTargetSelectionStorageKey(profile: GatewayProfile): string {
  return LOCAL_SELECTION_PREFIX + encodeURIComponent(profileScope(profile));
}

/** Exact target ownership identity. Access-token rotation within one authorization family is immaterial. */
export function settingsTargetIdentity(
  profile: GatewayProfile,
  server: KCoderServer,
  workspacePath: string | undefined = server.workspacePath,
): string {
  return JSON.stringify([
    profile.id,
    profile.baseUrl,
    profile.authorizationGeneration ?? "legacy:" + profile.id,
    profile.deviceId ?? null,
    server.id,
    server.runtime,
    server.transport,
    server.host ?? null,
    server.user ?? null,
    server.port ?? null,
    server.command ?? null,
    server.profile ?? null,
    server.settingsFile ?? null,
    server.accountIdentity?.principalId ?? null,
    server.accountIdentity?.username ?? null,
    server.accountIdentity?.role ?? null,
    server.chromiumBin ?? null,
    server.chromiumNoSandbox ?? null,
    server.acceptNewHostKey ?? null,
    [workspacePath === undefined ? "absent" : "value", workspacePath ?? ""],
  ]);
}

/** A saved choice wins; a missing choice only defaults when there is exactly one target. */
export function resolveSettingsServerId(
  servers: readonly KCoderServer[],
  savedServerId: string | null | undefined,
): string | null {
  if (savedServerId && servers.some((server) => server.id === savedServerId)) return savedServerId;
  return servers.length === 1 ? servers[0]?.id ?? null : null;
}

export async function loadSettingsServerChoice(profile: GatewayProfile): Promise<string | null> {
  const value = await AsyncStorage.getItem(settingsTargetSelectionStorageKey(profile));
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function saveSettingsServerChoice(
  profile: GatewayProfile,
  serverId: string,
  isCurrent: () => boolean,
): Promise<void> {
  const identity = captureWorkspaceProfileIdentity(profile);
  try {
    await withWorkspaceProfileMetadata(identity, async authority => {
      if (!isCurrent()) throw new SettingsTargetChangedError("not-sent");
      await metadataStorage(authority, () => { if (!isCurrent()) throw new SettingsTargetChangedError("not-sent"); }).setItem(settingsTargetSelectionStorageKey(profile), serverId);
      if (!isCurrent()) throw new SettingsTargetChangedError("not-sent");
    });
  } catch (error) {
    if (error instanceof WorkspaceProfileFenceError) throw new SettingsTargetChangedError("not-sent");
    throw error;
  }
  if (!isCurrent()) throw new SettingsTargetChangedError("not-sent");
}

export class SettingsTargetSession {
  readonly targetIdentity: string;
  readonly workspacePath: string | undefined;

  private active = true;
  private readonly historyViews = new SettingsHistoryViewOwners();
  private readonly profileIdentity: WorkspaceProfileIdentity;
  private readonly clients = new Map<SettingsTargetRpcChannel, SettingsTargetRpcClient>();
  private readonly clientCloseSubscriptions = new Map<
    SettingsTargetRpcChannel,
    { client: SettingsTargetRpcClient; unsubscribe: () => void }
  >();
  private readonly closeListeners = new Set<(event: SettingsTargetSessionCloseEvent) => void>();
  private readonly connecting = new Map<SettingsTargetRpcChannel, Promise<SettingsTargetRpcClient>>();
  private readonly controllers = new Map<SettingsTargetRpcChannel, AbortController>();

  constructor(
    private profile: GatewayProfile,
    private readonly server: KCoderServer,
    private readonly isCurrent: () => boolean,
    private readonly dependencies: SettingsTargetSessionDependencies = defaultDependencies,
  ) {
    this.workspacePath = server.workspacePath;
    this.targetIdentity = settingsTargetIdentity(profile, server, this.workspacePath);
    this.profileIdentity = captureWorkspaceProfileIdentity(profile);
  }

  /** Keep future channel connections on the latest credentials in this same authorization scope. */
  updateProfile(profile: GatewayProfile): void {
    if (settingsTargetIdentity(profile, this.server, this.workspacePath) !== this.targetIdentity)
      throw new SettingsTargetChangedError("not-sent");
    this.profile = profile;
  }

  connect(channel: SettingsTargetRpcChannel = "runtime"): Promise<SettingsTargetRpcClient> {
    return this.getClient(channel);
  }

  subscribeClose(listener: (event: SettingsTargetSessionCloseEvent) => void): () => void {
    if (!this.active) return () => {};
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  getCapabilities(): SettingsTargetCapabilities {
    const client = this.clients.get("runtime");
    return {
      gateway: this.server.capabilities ?? {},
      appServer: client?.getCapabilities() ?? null,
    };
  }

  async request<T>(
    method: string,
    params: unknown,
    channel: SettingsTargetRpcChannel,
  ): Promise<T> {
    this.assertCurrent("not-sent");
    if (typeof method !== "string" || method.trim().length === 0)
      throw new TypeError("RPC method must be a non-empty string");
    const rpcParams = this.toParams(params);
    const client = this.historyViews.existing(method, rpcParams, channel, this.clients.get(channel)) ?? await this.getClient(channel);
    this.assertCurrent("not-sent");
    this.historyViews.bind(method, rpcParams, channel, client);

    let dispatched = false;
    let started: { response: Promise<T> };
    try {
      started = await this.dependencies.profileRpc(this.profileIdentity, () => {
        this.assertCurrent("not-sent");
        if (this.historyViews.handles(method)) this.historyViews.existing(method, rpcParams, channel, this.clients.get(channel));
        const response = client.request<T>(method, rpcParams);
        dispatched = true;
        return response;
      });
      this.assertCurrent("unknown");
    } catch (error) {
      if (error instanceof WorkspaceProfileFenceError) throw new SettingsTargetChangedError("not-sent");
      if (!this.isActiveAndCurrent())
        throw new SettingsTargetChangedError(this.deliveryFor(error, dispatched));
      throw error;
    }

    try {
      const result = await started.response;
      this.assertCurrent("unknown");
      if (this.historyViews.handles(method)) this.historyViews.existing(method, rpcParams, channel, this.clients.get(channel), "unknown");
      return result;
    } catch (error) {
      if (!this.isActiveAndCurrent())
        throw new SettingsTargetChangedError(this.deliveryFor(error, true));
      throw error;
    }
  }

  close(): void {
    if (!this.active) return;
    this.active = false;
    this.historyViews.clear();
    for (const subscription of this.clientCloseSubscriptions.values()) {
      try {
        subscription.unsubscribe();
      } catch {
        // Removing an owned close observer is best effort.
      }
    }
    this.clientCloseSubscriptions.clear();
    this.closeListeners.clear();
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    for (const client of this.clients.values()) {
      try {
        client.close();
      } catch {
        // Closing an owned client is best effort; do not touch other sessions.
      }
    }
    this.clients.clear();
  }

  private async getClient(channel: SettingsTargetRpcChannel): Promise<SettingsTargetRpcClient> {
    this.assertCurrent("not-sent");
    const existing = this.clients.get(channel);
    if (existing) return existing;
    const pending = this.connecting.get(channel);
    if (pending) return pending;

    const controller = new AbortController();
    this.controllers.set(channel, controller);
    const rawConnection = Promise.resolve().then(async () => {
      this.assertCurrent("not-sent");
      try {
        const started = await this.dependencies.profileRpc(this.profileIdentity, () => {
          this.assertCurrent("not-sent");
          return this.dependencies.connect(
            this.profile,
            this.server,
            this.workspacePath,
            channel,
            { signal: controller.signal, priority: "foreground" },
          );
        });
        // Always observe the started connection so an invalidated owner can release its client.
        const client = await started.response;
        if (!this.isActiveAndCurrent() || controller.signal.aborted) {
          this.closeClient(client);
          throw new SettingsTargetChangedError("not-sent");
        }
        this.clients.set(channel, client);
        const unsubscribe = client.subscribeClose(() => this.handleClientClose(channel, client));
        if (this.clients.get(channel) !== client) {
          unsubscribe();
          throw new MobileRpcError("与 KCoder app-server 的连接已断开", -1, "transport", "not-sent");
        }
        this.clientCloseSubscriptions.set(channel, { client, unsubscribe });
        return client;
      } catch (error) {
        if (error instanceof WorkspaceProfileFenceError)
          throw new SettingsTargetChangedError("not-sent");
        if (!this.isActiveAndCurrent() || controller.signal.aborted)
          throw new SettingsTargetChangedError("not-sent");
        throw error;
      } finally {
        if (this.controllers.get(channel) === controller) this.controllers.delete(channel);
      }
    });
    const connection = this.waitForAbort(rawConnection, controller.signal);
    this.connecting.set(channel, connection);
    void connection.then(
      () => this.clearConnecting(channel, connection),
      () => this.clearConnecting(channel, connection),
    );
    return connection;
  }

  private waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new SettingsTargetChangedError("not-sent"));
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const onAbort = () => {
        cleanup();
        reject(new SettingsTargetChangedError("not-sent"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  private clearConnecting(channel: SettingsTargetRpcChannel, connection: Promise<SettingsTargetRpcClient>): void {
    if (this.connecting.get(channel) === connection) this.connecting.delete(channel);
  }

  private closeClient(client: SettingsTargetRpcClient): void {
    try {
      client.close();
    } catch {
      // A late connection that lost ownership is closed without affecting peers.
    }
  }

  private handleClientClose(channel: SettingsTargetRpcChannel, client: SettingsTargetRpcClient): void {
    if (this.clients.get(channel) !== client) return;
    this.clients.delete(channel);
    const subscription = this.clientCloseSubscriptions.get(channel);
    if (subscription?.client === client) {
      this.clientCloseSubscriptions.delete(channel);
      try {
        subscription.unsubscribe();
      } catch {
        // The client is already closed; removing its observer is best effort.
      }
    }
    const event = { channel } satisfies SettingsTargetSessionCloseEvent;
    for (const listener of [...this.closeListeners]) {
      try {
        listener(event);
      } catch {
        // A session observer cannot interrupt invalidation of the owned client.
      }
    }
  }

  private isActiveAndCurrent(): boolean {
    return this.active && this.isCurrent();
  }

  private assertCurrent(delivery: "not-sent" | "unknown"): void {
    if (!this.isActiveAndCurrent()) throw new SettingsTargetChangedError(delivery);
  }

  private deliveryFor(error: unknown, dispatched: boolean): "not-sent" | "unknown" {
    if (error instanceof MobileRpcError && error.delivery === "not-sent") return "not-sent";
    return dispatched ? "unknown" : "not-sent";
  }

  private toParams(params: unknown): JsonRecord {
    if (params === undefined) return {};
    if (!params || typeof params !== "object" || Array.isArray(params))
      throw new TypeError("RPC params must be an object");
    return params as JsonRecord;
  }
}
