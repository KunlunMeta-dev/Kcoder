import {
  createPeerSocket,
  getPeerTransportDiagnostics,
  peerFetch,
  releasePeerTransports,
  tryCreatePeerTransport,
} from "../../mobile/src/gateway/peer-transport";

interface SmokeConfig {
  pairingToken: string;
  publicBaseUrl: string;
  descriptor: unknown;
  accessTtlMs: number;
}

interface SmokeWindow extends Window {
  __mobilePeerTransportSmokeStage?: string;
  __continueMobilePeerTransportSmoke?: boolean;
  runMobilePeerTransportSmoke?: typeof runMobilePeerTransportSmoke;
}

export async function runMobilePeerTransportSmoke(config: SmokeConfig) {
  const page = window as SmokeWindow;
  const evidence: Record<string, unknown> = {
    secureContext: window.isSecureContext,
    webCrypto: Boolean(window.crypto?.subtle),
    browserRtc: typeof globalThis.RTCPeerConnection === "function",
    httpStatuses: [],
    rpc: [],
  };
  let pairingProfile: any;
  let profile: any;
  let peerUrl: string | undefined;
  let socket: ReturnType<typeof createPeerSocket> | undefined;
  try {
    if (!evidence.secureContext || !evidence.webCrypto || !evidence.browserRtc) {
      throw new Error("Browser transport smoke requires a secure context, WebCrypto, and native RTCPeerConnection");
    }
    pairingProfile = {
      id: "peer-transport-smoke-pairing",
      label: "owned P2P transport smoke",
      baseUrl: config.publicBaseUrl,
      authMode: "legacy",
      accessToken: config.pairingToken,
      rpcToken: config.pairingToken,
      expiresAt: Date.now() + 60_000,
    };
    const pairingPeerUrl = await tryCreatePeerTransport(
      pairingProfile,
      config.descriptor,
      config.publicBaseUrl,
      { auth: { kind: "pairing", token: config.pairingToken } },
    );
    if (!pairingPeerUrl) throw new Error("Browser pairing-scope P2P handshake failed");
    const pairingDiagnostics = await waitForDiagnostics(pairingPeerUrl);
    const pairingResponse = await peerFetch(`${pairingPeerUrl}/api/mobile/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: config.pairingToken,
        durableDeviceAuthorization: true,
        deviceLabel: "owned P2P browser transport smoke",
      }),
    });
    (evidence.httpStatuses as unknown[]).push({ method: "POST", path: "/api/mobile/session", status: pairingResponse.status });
    if (!pairingResponse.ok) throw new Error(`P2P pairing session returned HTTP ${pairingResponse.status}`);
    const session = await pairingResponse.json();
    if (typeof session.accessToken !== "string" || typeof session.rpcToken !== "string" ||
        typeof session.refreshToken !== "string" || typeof session.deviceId !== "string" ||
        typeof session.authorizationGeneration !== "string") {
      throw new Error("P2P pairing session did not return device authorization");
    }
    profile = {
      id: "peer-transport-smoke-profile",
      label: "owned P2P transport smoke",
      baseUrl: config.publicBaseUrl,
      authMode: "device",
      authorizationGeneration: session.authorizationGeneration,
      deviceId: session.deviceId,
      accessToken: session.accessToken,
      rpcToken: session.rpcToken,
      refreshToken: session.refreshToken,
      refreshExpiresAt: session.refreshExpiresAt,
      accessTtlMs: session.accessTtlMs,
      expiresAt: session.expiresAt,
    };
    releasePeerTransports(pairingProfile);

    peerUrl = await tryCreatePeerTransport(profile, config.descriptor, config.publicBaseUrl);
    if (!peerUrl) throw new Error("Browser profile-scope P2P handshake failed");
    const profileDiagnostics = await waitForDiagnostics(peerUrl);
    const serversResponse = await peerFetch(`${peerUrl}/api/servers`, {
      headers: { authorization: `Bearer ${profile.accessToken}` },
    });
    (evidence.httpStatuses as unknown[]).push({ method: "GET", path: "/api/servers", status: serversResponse.status });
    if (!serversResponse.ok) throw new Error(`P2P server inventory returned HTTP ${serversResponse.status}`);
    const serversPayload = await serversResponse.json();
    const server = Array.isArray(serversPayload?.servers) ? serversPayload.servers[0] : null;
    if (!server || typeof server.id !== "string") throw new Error("P2P server inventory returned no authorized target");

    page.__mobilePeerTransportSmokeStage = "peer-connected-awaiting-public-loss";
    await waitForHostSignal(page);
    await sleep(Math.max(6_000, config.accessTtlMs + 1_000));
    const rotationId = globalThis.crypto.randomUUID();
    const refreshResponse = await peerFetch(`${peerUrl}/api/mobile/session/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: profile.refreshToken, rotationId, deviceId: profile.deviceId }),
    });
    (evidence.httpStatuses as unknown[]).push({ method: "POST", path: "/api/mobile/session/refresh", status: refreshResponse.status });
    if (!refreshResponse.ok) throw new Error(`P2P session refresh returned HTTP ${refreshResponse.status}`);
    const refreshed = await refreshResponse.json();
    if (refreshed.deviceId !== profile.deviceId || refreshed.authorizationGeneration !== profile.authorizationGeneration ||
        typeof refreshed.accessToken !== "string" || typeof refreshed.rpcToken !== "string") {
      throw new Error("P2P session refresh changed the paired device identity or returned invalid credentials");
    }
    const priorDeviceId = profile.deviceId;
    const priorAuthorizationGeneration = profile.authorizationGeneration;
    const accessValueChanged = refreshed.accessToken !== profile.accessToken;
    profile = { ...profile, ...refreshed };
    evidence.refresh = {
      status: refreshResponse.status,
      deviceIdentityStable: refreshed.deviceId === priorDeviceId,
      authorizationGenerationStable: refreshed.authorizationGeneration === priorAuthorizationGeneration,
      accessValueChanged,
    };

    const refreshedServers = await peerFetch(`${peerUrl}/api/servers`, {
      headers: { authorization: `Bearer ${profile.accessToken}` },
    });
    (evidence.httpStatuses as unknown[]).push({ method: "GET", path: "/api/servers", status: refreshedServers.status });
    if (!refreshedServers.ok) throw new Error(`Post-refresh P2P server inventory returned HTTP ${refreshedServers.status}`);
    socket = await openRpcSocket(peerUrl, profile, server.id, typeof server.workspacePath === "string" ? server.workspacePath : undefined);
    const initialize = await rpcRequest(socket, 1, "initialize", {
      protocolVersion: "2026-07-27",
      clientInfo: { name: "kcoder-studio-mobile", version: "0.1.0" },
      capabilities: { experimental: { threadTranscriptSnapshotV1: true, threadTranscriptObservationV1: true } },
    });
    (evidence.rpc as unknown[]).push({ method: "initialize", result: Boolean(initialize?.protocolVersion) });
    socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
    const list = await rpcRequest(socket, 2, "thread/list", {});
    (evidence.rpc as unknown[]).push({ method: "thread/list", result: Array.isArray(list?.threads) });
    const read = await rpcRequest(socket, 3, "thread/read", { threadId: "mock-active-session", limit: 1 });
    (evidence.rpc as unknown[]).push({ method: "thread/read", result: read?.thread?.id === "mock-active-session" });
    if (!initialize?.protocolVersion || !Array.isArray(list?.threads) || read?.thread?.id !== "mock-active-session") {
      throw new Error("P2P RPC initialize/thread/list/thread/read did not return real Gateway results");
    }

    const finalDiagnostics = await waitForDiagnostics(peerUrl);
    evidence.pairingTransport = pairingDiagnostics;
    evidence.profileTransportBeforeLoss = profileDiagnostics;
    evidence.profileTransportAfterLoss = finalDiagnostics;
    evidence.selectedCandidatePair = {
      localCandidateType: finalDiagnostics.localCandidateType ?? null,
      remoteCandidateType: finalDiagnostics.remoteCandidateType ?? null,
    };
    if (!finalDiagnostics.localCandidateType || !finalDiagnostics.remoteCandidateType ||
        finalDiagnostics.bytesSent <= 0 || finalDiagnostics.bytesReceived <= 0 ||
        finalDiagnostics.state !== "open" || finalDiagnostics.dataChannelState !== "open") {
      throw new Error("Real browser P2P diagnostics did not show an open bidirectional direct DataChannel");
    }
    page.__mobilePeerTransportSmokeStage = "complete";
    return evidence;
  } catch (error) {
    page.__mobilePeerTransportSmokeStage = "failed";
    throw error;
  } finally {
    try { socket?.close(); } catch { /* Close only the smoke-owned logical RPC socket. */ }
    if (profile) releasePeerTransports(profile);
    if (pairingProfile) releasePeerTransports(pairingProfile);
  }
}

async function waitForDiagnostics(url: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const diagnostics = getPeerTransportDiagnostics(url);
    if (diagnostics?.state === "open" && diagnostics.localCandidateType && diagnostics.remoteCandidateType) return diagnostics;
    await sleep(50);
  }
  const diagnostics = getPeerTransportDiagnostics(url);
  if (!diagnostics) throw new Error("Browser P2P diagnostics are unavailable");
  return diagnostics;
}

async function openRpcSocket(peerUrl: string, profile: any, serverId: string, workspace?: string) {
  const url = new URL(`${peerUrl}/rpc`);
  url.searchParams.set("token", profile.rpcToken);
  url.searchParams.set("server", serverId);
  url.searchParams.set("channel", "runtime");
  if (workspace) url.searchParams.set("workspace", workspace);
  const socket = createPeerSocket(url.toString(), ["kcoder-studio", `kcoder-session.${profile.accessToken}`]);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("P2P RPC socket open timed out")), 10_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("P2P RPC socket failed to open")); }, { once: true });
  });
  return socket;
}

function rpcRequest(socket: ReturnType<typeof createPeerSocket>, id: number, method: string, params: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`P2P ${method} RPC timed out`)), 15_000);
    const onMessage = (event: MessageEvent) => {
      let messages: unknown;
      try { messages = JSON.parse(String(event.data)); } catch { return; }
      for (const item of Array.isArray(messages) ? messages : [messages]) {
        if (!item || typeof item !== "object" || item.id !== id) continue;
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        if (item.error) reject(new Error(`P2P ${method} RPC returned an error`));
        else resolve(item.result);
        return;
      }
    };
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

async function waitForHostSignal(page: SmokeWindow): Promise<void> {
  while (!page.__continueMobilePeerTransportSmoke) await sleep(50);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

(window as SmokeWindow).runMobilePeerTransportSmoke = runMobilePeerTransportSmoke;
