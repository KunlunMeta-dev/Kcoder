import { gatewayRequest, revokeMobileDevice } from "@/gateway/http";
import { getGatewayRouteSnapshot, invalidateGatewayRoute, normalizeGatewayConnectionRoutes, resolveGatewayRoute } from "@/gateway/connection-routes";
import { GatewayRpcClient } from "@/gateway/rpc";
import { getPeerTransportDiagnostics, releasePeerTransports } from "@/gateway/peer-transport";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { loadProfiles } from "@/storage/profile-store";
import { PEER_CHANNEL_LABEL } from "@shared/gatewayPeerTransport.js";

type BenchmarkMode = "lan" | "public-p2p" | "public-relay";

interface BenchmarkConfig {
  mode: BenchmarkMode;
  publicBaseUrl: string;
  expectedConnectionRoutes: unknown;
  expectedGatewayIps: string[];
  expectedClientIps: string[];
  expectedStunUrl?: string;
  fixture: {
    threadId: string;
    attachmentPath: string;
    size: number;
    sha256: string;
    chunkBytes: number;
    repetitions: number;
  };
  rttSamples: number;
  timeoutMs: number;
  attachmentTimeoutMs: number;
}

interface BenchmarkWindow extends Window {
  __runMobilePeerRouteBenchmark?: (config: BenchmarkConfig) => Promise<Record<string, unknown>>;
  __revokeMobilePeerRouteBenchmarkDevice?: (publicBaseUrl: string, expectedDeviceId: string) => Promise<Record<string, unknown>>;
  __listMobilePeerRouteBenchmarkDeviceIdentities?: (publicBaseUrl: string) => Promise<string[]>;
  __mobilePeerRouteBenchmarkRtc?: RtcRecord[];
}

interface RtcRecord {
  id: number;
  connection: RTCPeerConnection;
  bytesSent: number;
  bytesReceived: number;
  dataChannelLabel?: string;
  iceServerUrls: string[];
  hasIceServerCredentials: boolean;
}

interface AttachmentMeasurement {
  objectBytes: number;
  repetitions: Array<Record<string, unknown>>;
  totalBytes: number;
  hashVerified: boolean;
  complete: boolean;
  failure?: BenchmarkFailure;
}

interface BenchmarkFailure {
  stage: string;
  category: string;
  errorName: string;
  rpc?: {
    code: number;
    reason: "transport" | "remote" | "protocol";
    delivery: "not-sent" | "unknown";
  };
}

const benchmarkWindow = window as BenchmarkWindow;

function installRtcObserver(): void {
  if (benchmarkWindow.__mobilePeerRouteBenchmarkRtc) return;
  const records: RtcRecord[] = [];
  benchmarkWindow.__mobilePeerRouteBenchmarkRtc = records;
  const NativePeerConnection = window.RTCPeerConnection;
  if (typeof NativePeerConnection !== "function") return;

  const trackChannel = (record: RtcRecord, channel: RTCDataChannel) => {
    record.dataChannelLabel = channel.label;
    const send = channel.send.bind(channel);
    channel.send = ((data: string | Blob | ArrayBuffer | ArrayBufferView) => {
      const bytes = dataBytes(data);
      send(data);
      record.bytesSent += bytes;
    }) as typeof channel.send;
    channel.addEventListener("message", event => {
      record.bytesReceived += dataBytes(event.data);
    });
  };
  const WrappedPeerConnection = new Proxy(NativePeerConnection, {
    construct(target, args, newTarget) {
      const connection = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
      const configuration = (args[0] ?? {}) as RTCConfiguration;
      const iceServers = Array.isArray(configuration.iceServers) ? configuration.iceServers : [];
      const iceServerUrls = iceServers.flatMap(server => {
        const urls = server.urls;
        return (typeof urls === "string" ? [urls] : Array.isArray(urls) ? urls : [])
          .filter((url): url is string => typeof url === "string");
      });
      const hasIceServerCredentials = iceServers.some(server =>
        ("username" in server && Boolean(server.username)) || ("credential" in server && Boolean(server.credential)));
      const record: RtcRecord = {
        id: records.length + 1,
        connection,
        bytesSent: 0,
        bytesReceived: 0,
        iceServerUrls,
        hasIceServerCredentials,
      };
      records.push(record);
      const createDataChannel = connection.createDataChannel.bind(connection);
      connection.createDataChannel = ((label: string, options?: RTCDataChannelInit) => {
        const channel = createDataChannel(label, options);
        trackChannel(record, channel);
        return channel;
      }) as typeof connection.createDataChannel;
      connection.addEventListener("datachannel", event => trackChannel(record, event.channel));
      return connection;
    },
  });
  Object.defineProperty(window, "RTCPeerConnection", {
    configurable: true,
    writable: true,
    value: WrappedPeerConnection,
  });
}

function dataBytes(value: unknown): number {
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
  return 0;
}

function canonicalUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

async function findProfile(publicBaseUrl: string): Promise<GatewayProfile> {
  const loaded = await loadProfiles();
  const expected = canonicalUrl(publicBaseUrl);
  const profiles = loaded.profiles.filter(profile => canonicalUrl(profile.baseUrl) === expected);
  const active = profiles.find(profile => profile.id === loaded.activeId);
  const profile = active ?? profiles.at(-1);
  if (!profile || !profile.accessToken || !profile.rpcToken || !profile.deviceId) {
    throw new Error("No complete, freshly paired Mobile profile matches the configured Gateway");
  }
  return profile;
}

async function listDeviceIdentities(publicBaseUrl: string): Promise<string[]> {
  const loaded = await loadProfiles();
  const expected = canonicalUrl(publicBaseUrl);
  return loaded.profiles
    .filter(profile => canonicalUrl(profile.baseUrl) === expected && typeof profile.deviceId === "string")
    .map(profile => profile.deviceId as string);
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarizeSamples(samples: Array<{ elapsedMs: number; ok: boolean }>, warmup: { elapsedMs: number; ok: boolean }) {
  const successful = samples.filter(sample => sample.ok).map(sample => sample.elapsedMs);
  return {
    requested: samples.length,
    succeeded: successful.length,
    failed: samples.length - successful.length,
    warmup,
    p50Ms: percentile(successful, 0.50),
    p95Ms: percentile(successful, 0.95),
    samples: samples.map(sample => ({ elapsedMs: Number(sample.elapsedMs.toFixed(3)), ok: sample.ok })),
  };
}

async function timeOperation(operation: () => Promise<unknown>): Promise<{ elapsedMs: number; ok: boolean }> {
  const started = performance.now();
  try {
    await operation();
    return { elapsedMs: performance.now() - started, ok: true };
  } catch {
    return { elapsedMs: performance.now() - started, ok: false };
  }
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function joinBytes(parts: Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  if (offset !== total) throw new Error("Attachment chunk byte count did not match the configured object size");
  return result;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

function ipAddress(candidate: RTCIceCandidateStats | undefined): string | null {
  if (!candidate) return null;
  const row = candidate as unknown as Record<string, unknown>;
  const value = row.address ?? row.ip;
  return typeof value === "string" && value.length <= 128 && isIpLiteral(value) ? value : null;
}

function isIpLiteral(value: string): boolean {
  const octets = value.split(".");
  if (octets.length === 4 && octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return true;
  return value.includes(":") && /^[0-9a-f:.]+$/i.test(value) && value.split(":").length >= 3;
}

async function selectedPairs(records: RtcRecord[]): Promise<Array<Record<string, unknown>>> {
  const selected: Array<Record<string, unknown>> = [];
  for (const record of records) {
    let report: RTCStatsReport;
    try { report = await record.connection.getStats(); }
    catch { continue; }
    const stats = [...report.values()];
    const transport = stats.find(item => item.type === "transport" && typeof item.selectedCandidatePairId === "string");
    const pairId = (transport as RTCTransportStats | undefined)?.selectedCandidatePairId;
    const pair = pairId
      ? stats.find(item => item.type === "candidate-pair" && item.id === pairId)
      : stats.find(item => item.type === "candidate-pair" &&
        ((item as RTCIceCandidatePairStats).selected === true ||
          ((item as RTCIceCandidatePairStats).nominated === true && (item as RTCIceCandidatePairStats).state === "succeeded")));
    if (!pair) continue;
    const pairStats = pair as RTCIceCandidatePairStats;
    if (pairStats.state !== "succeeded") continue;
    const local = stats.find(item => item.type === "local-candidate" && item.id === pairStats.localCandidateId) as RTCIceCandidateStats | undefined;
    const remote = stats.find(item => item.type === "remote-candidate" && item.id === pairStats.remoteCandidateId) as RTCIceCandidateStats | undefined;
    selected.push({
      peerConnectionId: record.id,
      pairId: pair.id,
      state: pairStats.state,
      nominated: pairStats.nominated === true,
      selected: pairStats.selected === true || pairId === pair.id,
      localAddress: ipAddress(local),
      remoteAddress: ipAddress(remote),
      localCandidateType: local?.candidateType ?? null,
      remoteCandidateType: remote?.candidateType ?? null,
      bytesSent: Number.isFinite(pairStats.bytesSent) ? pairStats.bytesSent : null,
      bytesReceived: Number.isFinite(pairStats.bytesReceived) ? pairStats.bytesReceived : null,
    });
  }
  return selected;
}

async function measureAttachment(
  rpc: GatewayRpcClient,
  fixture: BenchmarkConfig["fixture"] & { timeoutMs: number },
): Promise<AttachmentMeasurement> {
  if (fixture.size !== 1024 * 1024 || fixture.chunkBytes !== 512 * 1024 || fixture.repetitions !== 3) {
    throw new Error("Benchmark fixture must be a fixed 1 MiB object, 512 KiB chunks, and three repetitions");
  }
  const repetitions: Array<Record<string, unknown>> = [];
  let totalBytes = 0;
  for (let repetition = 1; repetition <= fixture.repetitions; repetition += 1) {
    const chunks: Uint8Array[] = [];
    const segments: Array<Record<string, unknown>> = [];
    let offset = 0;
    while (offset < fixture.size) {
      const length = Math.min(fixture.chunkBytes, fixture.size - offset);
      const started = performance.now();
      try {
        const result = await rpc.request<{
          contentBase64?: string;
          offset?: number;
          size?: number;
          totalSize?: number;
          eof?: boolean;
        }>("attachment/read/chunk", {
          threadId: fixture.threadId,
          path: fixture.attachmentPath,
          offset,
          length,
        }, fixture.timeoutMs);
        const elapsedMs = performance.now() - started;
        if (result.offset !== offset || result.totalSize !== fixture.size || typeof result.contentBase64 !== "string") {
          throw new Error("Fixture attachment returned an unexpected chunk offset, size, or encoding");
        }
        const bytes = decodeBase64(result.contentBase64);
        if (result.size !== bytes.byteLength || bytes.byteLength !== length || result.eof !== (offset + length === fixture.size)) {
          throw new Error("Fixture attachment chunk failed the size or EOF contract");
        }
        chunks.push(bytes);
        totalBytes += bytes.byteLength;
        segments.push({
          offset,
          bytes: bytes.byteLength,
          elapsedMs: Number(elapsedMs.toFixed(3)),
          megabytesPerSecond: elapsedMs > 0
            ? Number((bytes.byteLength / 1024 / 1024 / (elapsedMs / 1000)).toFixed(3))
            : null,
        });
        offset += bytes.byteLength;
      } catch (error) {
        repetitions.push({
          repetition,
          bytes: offset,
          hashMatches: false,
          complete: false,
          segments,
        });
        return {
          objectBytes: fixture.size,
          repetitions,
          totalBytes,
          hashVerified: false,
          complete: false,
          failure: benchmarkFailure("attachment-read-chunk", error),
        };
      }
    }
    try {
      const bytes = joinBytes(chunks, fixture.size);
      const actualHash = await sha256(bytes);
      const hashMatches = actualHash === fixture.sha256;
      repetitions.push({
        repetition,
        bytes: bytes.byteLength,
        sha256: actualHash,
        hashMatches,
        complete: hashMatches,
        elapsedMs: Number(segments.reduce((sum, item) => sum + Number(item.elapsedMs), 0).toFixed(3)),
        segments,
      });
      if (!hashMatches) {
        return {
          objectBytes: fixture.size,
          repetitions,
          totalBytes,
          hashVerified: false,
          complete: false,
          failure: { stage: "attachment-sha256", category: "integrity-mismatch", errorName: "IntegrityError" },
        };
      }
    } catch (error) {
      repetitions.push({ repetition, bytes: offset, hashMatches: false, complete: false, segments });
      return {
        objectBytes: fixture.size,
        repetitions,
        totalBytes,
        hashVerified: false,
        complete: false,
        failure: benchmarkFailure("attachment-integrity", error),
      };
    }
  }
  return { objectBytes: fixture.size, repetitions, totalBytes, hashVerified: true, complete: true };
}

function benchmarkFailure(stage: string, error: unknown): BenchmarkFailure {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : String(error);
  const status = message.match(/\b(?:HTTP|status)\s*[:=]?\s*(\d{3})\b/i)?.[1];
  const category = /timeout|timed out|deadline|超时/i.test(message) ? "timeout"
    : /sha-?256|hash|integrity/i.test(message) ? "integrity-mismatch"
      : /offset|encoding|chunk|eof|size contract/i.test(message) ? "response-contract"
        : status ? `http-${status}`
          : /network|socket|websocket|closed|connect/i.test(message) ? "transport-error"
            : "operation-error";
  const rpcError = error instanceof Error && name === "MobileRpcError"
    ? error as Error & { code?: unknown; reason?: unknown; delivery?: unknown }
    : undefined;
  const rpcReason = rpcError?.reason;
  const rpcDelivery = rpcError?.delivery;
  const rpc = rpcError && Number.isSafeInteger(rpcError.code) &&
      (rpcReason === "transport" || rpcReason === "remote" || rpcReason === "protocol") &&
      (rpcDelivery === "not-sent" || rpcDelivery === "unknown")
    ? { code: rpcError.code as number, reason: rpcReason, delivery: rpcDelivery }
    : undefined;
  return {
    stage,
    category,
    errorName: /^[A-Za-z][A-Za-z0-9]{0,47}$/.test(name) ? name : "Error",
    ...(rpc ? { rpc } : {}),
  };
}

export async function runMobilePeerRouteBenchmark(config: BenchmarkConfig): Promise<Record<string, unknown>> {
  installRtcObserver();
  const expectedKind = config.mode === "lan" ? "lan" : config.mode === "public-p2p" ? "peer" : "legacy-public";
  let stage = "profile-resolution";
  let baseProfile: GatewayProfile | undefined;
  let profile: GatewayProfile | undefined;
  let rpc: GatewayRpcClient | undefined;
  let initiallySelectedUrl = "";
  let routeElapsedMs: number | undefined;
  let routeKind = config.mode === "public-relay" ? "legacy-public" : "unknown";
  let httpUrl = "";
  let rpcUrl = "";
  let serverElapsedMs: number | undefined;
  let serverCount: number | undefined;
  let connectionElapsedMs: number | undefined;
  let warmup = { elapsedMs: 0, ok: false };
  let warmupObserved = false;
  const samples: Array<{ elapsedMs: number; ok: boolean }> = [];
  const records = config.mode === "public-p2p" ? (benchmarkWindow.__mobilePeerRouteBenchmarkRtc ?? []) : [];
  let pairsBefore: Array<Record<string, unknown>> = [];
  let pairsAfter: Array<Record<string, unknown>> = [];
  let pairsBeforeCaptured = false;
  let pairsAfterCaptured = false;
  let channelBefore = new Map<number, { sent: number; received: number }>();
  let download: AttachmentMeasurement = {
    objectBytes: config.fixture.size,
    repetitions: [],
    totalBytes: 0,
    hashVerified: false,
    complete: false,
  };
  let signedRouteDescriptorMatches = false;
  try {
    stage = "profile-resolution";
    baseProfile = await findProfile(config.publicBaseUrl);
    const expectedRoutes = normalizeGatewayConnectionRoutes(config.expectedConnectionRoutes);
    const actualRoutes = normalizeGatewayConnectionRoutes(baseProfile.connectionRoutes);
    signedRouteDescriptorMatches = Boolean(expectedRoutes && actualRoutes &&
      JSON.stringify(expectedRoutes) === JSON.stringify(actualRoutes));
    profile = config.mode === "public-relay"
      ? { ...baseProfile, id: `${baseProfile.id}-route-benchmark-relay`, connectionRoutes: undefined }
      : baseProfile;

    stage = "route-resolution";
    const routeStarted = performance.now();
    initiallySelectedUrl = await resolveGatewayRoute(profile);
    routeElapsedMs = performance.now() - routeStarted;
    const resolutionSnapshot = getGatewayRouteSnapshot(profile);
    routeKind = resolutionSnapshot?.kind ?? (config.mode === "public-relay" ? "legacy-public" : "unknown");
    rpcUrl = resolutionSnapshot?.url ?? initiallySelectedUrl;

    stage = "gateway-http-servers";
    const serverStarted = performance.now();
    let serverPayload: { servers?: KCoderServer[] };
    try {
      serverPayload = await gatewayRequest<{ servers?: KCoderServer[] }>(profile, "/api/servers");
    } finally {
      serverElapsedMs = performance.now() - serverStarted;
    }
    const httpSnapshot = getGatewayRouteSnapshot(profile);
    httpUrl = httpSnapshot?.url ?? initiallySelectedUrl;
    routeKind = httpSnapshot?.kind ?? routeKind;
    rpcUrl = httpUrl;
    const server = serverPayload.servers?.find(item => item?.runtime === "kcoder");
    serverCount = serverPayload.servers?.length ?? 0;
    if (!server || typeof server.id !== "string") throw new Error("Mobile Gateway HTTP API returned no KCoder target for the benchmark");

    stage = "rpc-connect-initialize";
    const connectStarted = performance.now();
    const rpcClient = await GatewayRpcClient.connect(profile, server, server.workspacePath, "runtime");
    rpc = rpcClient;
    connectionElapsedMs = performance.now() - connectStarted;
    const rpcSnapshot = getGatewayRouteSnapshot(profile);
    rpcUrl = rpcSnapshot?.url ?? httpUrl;
    routeKind = rpcSnapshot?.kind ?? routeKind;

    stage = "rpc-rtt-warmup";
    warmup = await timeOperation(async () => {
      const result = await rpcClient.request<{ threads?: Array<{ id?: string }> }>("thread/list", {}, config.timeoutMs);
      if (!Array.isArray(result.threads) || !result.threads.some(thread => thread.id === config.fixture.threadId)) {
        throw new Error("The fixture thread was not present in the warmup thread/list response");
      }
    });
    warmupObserved = true;
    stage = "rpc-rtt-samples";
    for (let index = 0; index < config.rttSamples; index += 1) {
      samples.push(await timeOperation(async () => {
        const result = await rpcClient.request<{ threads?: Array<{ id?: string }> }>("thread/list", {}, config.timeoutMs);
        if (!Array.isArray(result.threads) || !result.threads.some(thread => thread.id === config.fixture.threadId)) {
          throw new Error("Fixture thread missing from thread/list response");
        }
      }));
    }

    // Include connections created during pairing: route resolution may reuse that live product connection.
    stage = "selected-pair-before-transfer";
    pairsBefore = await selectedPairs(records);
    pairsBeforeCaptured = true;
    channelBefore = new Map(records.map(record => [record.id, { sent: record.bytesSent, received: record.bytesReceived }]));
    const peerDiagnosticsBefore = rpcUrl.startsWith("kcoder-p2p:")
      ? await getPeerTransportDiagnostics(rpcUrl)
      : undefined;
    stage = "attachment-read-chunk";
    download = await measureAttachment(rpcClient, { ...config.fixture, timeoutMs: config.attachmentTimeoutMs });
    stage = "selected-pair-after-transfer";
    const postTransferSnapshot = getGatewayRouteSnapshot(profile);
    const postTransferUrl = postTransferSnapshot?.url ?? rpcUrl;
    const postTransferKind = postTransferSnapshot?.kind ?? routeKind;
    pairsAfter = await selectedPairs(records);
    pairsAfterCaptured = true;
    const peerDiagnosticsAfter = rpcUrl.startsWith("kcoder-p2p:")
      ? await getPeerTransportDiagnostics(rpcUrl)
      : undefined;
    const channelDeltas = records.map(record => {
      const before = channelBefore.get(record.id) ?? { sent: 0, received: 0 };
      return { peerConnectionId: record.id, dataChannelLabel: record.dataChannelLabel ?? null, bytesSent: record.bytesSent - before.sent, bytesReceived: record.bytesReceived - before.received };
    });
    const channelSentDelta = channelDeltas.reduce((total, item) => total + item.bytesSent, 0);
    const channelReceivedDelta = channelDeltas.reduce((total, item) => total + item.bytesReceived, 0);
    const pairByteDeltas = pairsAfter.map(pair => {
      const before = pairsBefore.find(item => item.peerConnectionId === pair.peerConnectionId && item.pairId === pair.pairId);
      const channel = channelDeltas.find(item => item.peerConnectionId === pair.peerConnectionId);
      return {
        peerConnectionId: pair.peerConnectionId,
        pairId: pair.pairId,
        state: pair.state,
        selected: pair.selected,
        localAddress: pair.localAddress,
        remoteAddress: pair.remoteAddress,
        localCandidateType: pair.localCandidateType,
        remoteCandidateType: pair.remoteCandidateType,
        dataChannelLabel: channel?.dataChannelLabel ?? null,
        dataChannelBytesSent: channel?.bytesSent ?? 0,
        dataChannelBytesReceived: channel?.bytesReceived ?? 0,
        bytesSent: before && Number.isFinite(Number(pair.bytesSent)) && Number.isFinite(Number(before.bytesSent))
          ? Math.max(0, Number(pair.bytesSent) - Number(before.bytesSent)) : null,
        bytesReceived: before && Number.isFinite(Number(pair.bytesReceived)) && Number.isFinite(Number(before.bytesReceived))
          ? Math.max(0, Number(pair.bytesReceived) - Number(before.bytesReceived)) : null,
      };
    });
    const peerDiagnosticsSentDelta = peerDiagnosticsAfter && peerDiagnosticsBefore
      ? peerDiagnosticsAfter.bytesSent - peerDiagnosticsBefore.bytesSent : null;
    const peerDiagnosticsReceivedDelta = peerDiagnosticsAfter && peerDiagnosticsBefore
      ? peerDiagnosticsAfter.bytesReceived - peerDiagnosticsBefore.bytesReceived : null;
    const correlatedSessionChannels = channelDeltas.filter(channel => channel.dataChannelLabel === PEER_CHANNEL_LABEL &&
      channel.bytesSent === peerDiagnosticsSentDelta && channel.bytesReceived === peerDiagnosticsReceivedDelta);
    const sessionDataChannelCorrelationVerified = correlatedSessionChannels.length === 1 &&
      Number(peerDiagnosticsSentDelta) > 0 && Number(peerDiagnosticsReceivedDelta) > 0;
    const sessionPeerConnectionId = sessionDataChannelCorrelationVerified
      ? correlatedSessionChannels[0].peerConnectionId : null;
    const sessionPeerConnection = records.find(record => record.id === sessionPeerConnectionId);
    const p2pIceConfigurationVerified = config.mode === "public-p2p" && Boolean(config.expectedStunUrl) &&
      Boolean(sessionPeerConnection && !sessionPeerConnection.hasIceServerCredentials &&
        sessionPeerConnection.iceServerUrls.length === 1 &&
        sessionPeerConnection.iceServerUrls[0] === config.expectedStunUrl &&
        sessionPeerConnection.iceServerUrls.every(url => url.startsWith("stun:")));
    const dataChannelPayloadBase64LowerBound = config.fixture.repetitions * Math.ceil(config.fixture.size / 3) * 4;
    const expectedBusinessPair = pairByteDeltas.find(pair => pair.selected === true &&
      pair.peerConnectionId === sessionPeerConnectionId &&
      config.expectedGatewayIps.includes(String(pair.remoteAddress)) &&
      config.expectedClientIps.includes(String(pair.localAddress)));
    const expectedAddressPairMatches = Boolean(expectedBusinessPair);
    const selectedPairNoRelayCandidate = Boolean(expectedBusinessPair &&
      typeof expectedBusinessPair.localCandidateType === "string" && expectedBusinessPair.localCandidateType !== "relay" &&
      typeof expectedBusinessPair.remoteCandidateType === "string" && expectedBusinessPair.remoteCandidateType !== "relay");
    const positiveSelectedPairBusinessBytes = Boolean(expectedBusinessPair &&
      Number(expectedBusinessPair.bytesSent) > 0 && Number(expectedBusinessPair.bytesReceived) > 0);
    const dataChannelReceivedBytesCoverPayload = Number(expectedBusinessPair?.dataChannelBytesReceived) >= dataChannelPayloadBase64LowerBound;
    const p2pDataPlaneVerified = config.mode === "public-p2p" && routeKind === "peer" &&
      expectedAddressPairMatches && selectedPairNoRelayCandidate && positiveSelectedPairBusinessBytes &&
      sessionDataChannelCorrelationVerified && p2pIceConfigurationVerified &&
      Number(expectedBusinessPair?.dataChannelBytesSent) > 0 && dataChannelReceivedBytesCoverPayload;
    const routeEndpointExpectationMet = config.mode === "lan"
      ? (() => { try { const url = new URL(rpcUrl); return url.protocol === "https:" && config.expectedGatewayIps.includes(url.hostname); } catch { return false; } })()
      : config.mode === "public-p2p"
        ? rpcUrl.startsWith("kcoder-p2p:")
        : (() => { try { return canonicalUrl(rpcUrl) === canonicalUrl(config.publicBaseUrl); } catch { return false; } })();
    const routeStableDuringBusinessTransfer = postTransferKind === routeKind && postTransferUrl === rpcUrl;
    const routeExpectationMet = routeKind === expectedKind && routeEndpointExpectationMet && routeStableDuringBusinessTransfer &&
      (config.mode === "public-relay" || signedRouteDescriptorMatches);
    const allRttSucceeded = samples.length === config.rttSamples && samples.every(sample => sample.ok) && warmup.ok;
    const downloadedBytes = Number(download.totalBytes);
    const downloadWithinBudget = downloadedBytes === config.fixture.size * config.fixture.repetitions &&
      downloadedBytes <= 10 * 1024 * 1024;
    const measurementComplete = routeExpectationMet && allRttSucceeded && download.hashVerified === true && downloadWithinBudget &&
      (config.mode !== "public-p2p" || p2pDataPlaneVerified);

    return {
      mode: config.mode,
      status: measurementComplete ? "complete" : "partial",
      ...(download.failure ? { stageFailure: download.failure } : {}),
      route: {
        expectedKind,
        selectedKind: routeKind,
        selectedEndpoint: safeEndpoint(rpcUrl),
        resolutionMs: Number((routeElapsedMs ?? 0).toFixed(3)),
        gatewayHttpEndpoint: safeEndpoint(httpUrl),
        selectedAfterBusinessTransfer: safeEndpoint(postTransferUrl),
        routeStableDuringBusinessTransfer,
        selectedAfterSignedRouteVerification: Boolean(rpcSnapshot) && signedRouteDescriptorMatches,
        signedRouteDescriptorMatches,
        routeEndpointExpectationMet,
        expectationMet: routeExpectationMet,
      },
      mobileProfile: {
        authMode: baseProfile.authMode ?? "legacy",
        deviceIdentityPresent: Boolean(baseProfile.deviceId),
        signedRoutesPresent: baseProfile.connectionRoutes !== undefined,
      },
      gatewayHttp: {
        method: "GET",
        path: "/api/servers",
        transportEndpoint: safeEndpoint(httpUrl),
        elapsedMs: Number((serverElapsedMs ?? 0).toFixed(3)),
        serverCount: serverCount ?? 0,
      },
      rpcConnection: {
        transport: "WebSocket JSON-RPC",
        transportEndpoint: safeEndpoint(rpcUrl),
        elapsedMs: Number((connectionElapsedMs ?? 0).toFixed(3)),
        includesInitialize: connectionElapsedMs !== undefined,
      },
      rpcRtt: { method: "thread/list", ...summarizeSamples(samples, warmup) },
      download,
      fixedPayloadBudget: {
        maximumBytes: 10 * 1024 * 1024,
        measuredBusinessBytes: downloadedBytes,
        withinBudget: downloadWithinBudget,
      },
      dataPlane: {
        iceSelectedPairsBefore: pairsBefore,
        iceSelectedPairsAfter: pairsAfter,
        iceSelectedPairBusinessByteDeltas: pairByteDeltas,
        expectedGatewayIps: config.expectedGatewayIps,
        expectedClientIps: config.expectedClientIps,
        selectedPairAddressesMatchExpectedTopology: expectedAddressPairMatches,
        selectedPairHasNoRelayCandidate: selectedPairNoRelayCandidate,
        dataChannelPayloadBytesSentDelta: channelSentDelta,
        dataChannelPayloadBytesReceivedDelta: channelReceivedDelta,
        dataChannelPayloadDeltasByPeerConnection: channelDeltas,
        productionPeerSessionPayloadByteDeltas: {
          bytesSent: peerDiagnosticsSentDelta,
          bytesReceived: peerDiagnosticsReceivedDelta,
        },
        sessionDataChannelCorrelationVerified,
        sessionPeerConnectionId,
        p2pIceConfiguration: sessionPeerConnection ? {
          servers: sessionPeerConnection.iceServerUrls.map(url => ({
            scheme: /^([a-z][a-z0-9+.-]{0,15}):/i.exec(url)?.[1]?.toLowerCase() ?? "unknown",
            matchesExpected: url === config.expectedStunUrl,
            ...(url === config.expectedStunUrl ? { expectedEndpoint: config.expectedStunUrl } : {}),
          })),
          hasCredentials: sessionPeerConnection.hasIceServerCredentials,
          exactExpectedStunOnly: p2pIceConfigurationVerified,
          evidenceBoundary: "captured from the actual RTCPeerConnection configuration passed to the Mobile transport; this does not mean payload bytes travel through STUN",
        } : null,
        dataChannelPayloadBase64LowerBound,
        dataChannelReceivedBytesCoverPayload,
        p2pDataPlaneVerified,
        mobilePeerTransportDiagnostics: peerDiagnosticsAfter ? {
          state: peerDiagnosticsAfter.state,
          peerConnectionState: peerDiagnosticsAfter.peerConnectionState,
          dataChannelState: peerDiagnosticsAfter.dataChannelState,
          bytesSent: peerDiagnosticsAfter.bytesSent,
          bytesReceived: peerDiagnosticsAfter.bytesReceived,
        } : null,
        evidenceBoundary: config.mode === "public-p2p"
          ? "selected ICE candidate-pair getStats is matched to the opaque Mobile P2P session by exact production payload-counter deltas and the observed product DataChannel label; fixture SHA-256 validates returned app bytes; counters are not wire-byte totals"
          : "no WebRTC counters are attributed to this non-P2P benchmark lane; fixture SHA-256 validates returned app bytes",
      },
      quality: {
        allRttSucceeded,
        downloadHashVerified: download.hashVerified === true,
        downloadWithinBudget,
        routeExpectationMet,
        signedRouteDescriptorMatches,
        p2pDataPlaneVerified,
        sessionDataChannelCorrelationVerified,
        p2pIceConfigurationVerified,
        measurementComplete,
      },
    };
  } catch (error) {
    const failure = benchmarkFailure(stage, error);
    let observedPeerUrl = rpcUrl;
    if (profile) {
      try {
        const currentSnapshot = getGatewayRouteSnapshot(profile);
        if (currentSnapshot) {
          routeKind = currentSnapshot.kind;
          rpcUrl = currentSnapshot.url;
          observedPeerUrl = currentSnapshot.url;
        }
      } catch {
        // Keep the last route evidence already captured before the failing stage.
      }
    }
    if (!pairsAfterCaptured) {
      try {
        pairsAfter = await selectedPairs(records);
        pairsAfterCaptured = true;
      } catch {
        // Candidate stats are best-effort evidence on a failed lane.
      }
    }
    const channelDeltas = records.map(record => {
      const before = channelBefore.get(record.id);
      return {
        peerConnectionId: record.id,
        dataChannelLabel: record.dataChannelLabel ?? null,
        baselineCaptured: before !== undefined,
        bytesSent: before ? record.bytesSent - before.sent : null,
        bytesReceived: before ? record.bytesReceived - before.received : null,
      };
    });
    const pairByteDeltas = pairsAfter.map(pair => {
      const before = pairsBefore.find(item => item.peerConnectionId === pair.peerConnectionId && item.pairId === pair.pairId);
      return {
        peerConnectionId: pair.peerConnectionId,
        pairId: pair.pairId,
        state: pair.state,
        selected: pair.selected,
        localAddress: pair.localAddress,
        remoteAddress: pair.remoteAddress,
        localCandidateType: pair.localCandidateType,
        remoteCandidateType: pair.remoteCandidateType,
        bytesSent: before && Number.isFinite(Number(pair.bytesSent)) && Number.isFinite(Number(before.bytesSent))
          ? Math.max(0, Number(pair.bytesSent) - Number(before.bytesSent)) : null,
        bytesReceived: before && Number.isFinite(Number(pair.bytesReceived)) && Number.isFinite(Number(before.bytesReceived))
          ? Math.max(0, Number(pair.bytesReceived) - Number(before.bytesReceived)) : null,
      };
    });
    let peerDiagnostics: Awaited<ReturnType<typeof getPeerTransportDiagnostics>>;
    let peerDiagnosticsFailure;
    if (config.mode === "public-p2p" && observedPeerUrl.startsWith("kcoder-p2p:")) {
      try { peerDiagnostics = await getPeerTransportDiagnostics(observedPeerUrl); }
      catch (statsError) { peerDiagnosticsFailure = benchmarkFailure("mobile-peer-session-stats", statsError); }
    }
    const rttSummary = warmupObserved
      ? { ...summarizeSamples(samples, warmup), requested: config.rttSamples, recorded: samples.length }
      : {
        requested: config.rttSamples,
        recorded: samples.length,
        succeeded: samples.filter(sample => sample.ok).length,
        failed: samples.filter(sample => !sample.ok).length,
        pending: config.rttSamples - samples.length,
        warmup: null,
        p50Ms: percentile(samples.filter(sample => sample.ok).map(sample => sample.elapsedMs), 0.50),
        p95Ms: percentile(samples.filter(sample => sample.ok).map(sample => sample.elapsedMs), 0.95),
        samples: samples.map(sample => ({ elapsedMs: Number(sample.elapsedMs.toFixed(3)), ok: sample.ok })),
      };
    const allRttSucceeded = Boolean(warmup?.ok && samples.length === config.rttSamples && samples.every(sample => sample.ok));
    const downloadWithinBudget = download.totalBytes <= 10 * 1024 * 1024;
    const selectedEndpoint = safeEndpoint(observedPeerUrl);
    return {
      mode: config.mode,
      status: "partial",
      stageFailure: failure,
      route: {
        expectedKind,
        selectedKind: routeKind,
        selectedEndpoint,
        resolutionMs: routeElapsedMs === undefined ? null : Number(routeElapsedMs.toFixed(3)),
        gatewayHttpEndpoint: httpUrl ? safeEndpoint(httpUrl) : null,
        selectedAfterBusinessTransfer: selectedEndpoint,
        routeStableDuringBusinessTransfer: false,
        selectedAfterSignedRouteVerification: false,
        signedRouteDescriptorMatches,
        routeEndpointExpectationMet: false,
        expectationMet: false,
      },
      mobileProfile: baseProfile ? {
        authMode: baseProfile.authMode ?? "legacy",
        deviceIdentityPresent: Boolean(baseProfile.deviceId),
        signedRoutesPresent: baseProfile.connectionRoutes !== undefined,
      } : { profileResolved: false },
      gatewayHttp: {
        method: "GET",
        path: "/api/servers",
        transportEndpoint: httpUrl ? safeEndpoint(httpUrl) : null,
        elapsedMs: serverElapsedMs === undefined ? null : Number(serverElapsedMs.toFixed(3)),
        serverCount: serverCount ?? null,
      },
      rpcConnection: {
        transport: "WebSocket JSON-RPC",
        transportEndpoint: rpcUrl ? safeEndpoint(rpcUrl) : null,
        elapsedMs: connectionElapsedMs === undefined ? null : Number(connectionElapsedMs.toFixed(3)),
        includesInitialize: connectionElapsedMs !== undefined,
      },
      rpcRtt: { method: "thread/list", ...rttSummary },
      download: { ...download, failure: download.failure ?? null },
      fixedPayloadBudget: {
        maximumBytes: 10 * 1024 * 1024,
        measuredBusinessBytes: download.totalBytes,
        withinBudget: downloadWithinBudget,
      },
      dataPlane: {
        iceSelectedPairsBefore: pairsBeforeCaptured ? pairsBefore : null,
        iceSelectedPairsAfter: pairsAfterCaptured ? pairsAfter : null,
        iceSelectedPairBusinessByteDeltas: pairByteDeltas,
        expectedGatewayIps: config.expectedGatewayIps,
        expectedClientIps: config.expectedClientIps,
        selectedPairAddressesMatchExpectedTopology: false,
        selectedPairHasNoRelayCandidate: false,
        dataChannelPayloadDeltasByPeerConnection: channelDeltas,
        productionPeerSessionPayloadByteDeltas: peerDiagnostics ? {
          bytesSent: peerDiagnostics.bytesSent,
          bytesReceived: peerDiagnostics.bytesReceived,
        } : null,
        mobilePeerTransportDiagnostics: peerDiagnostics ? {
          state: peerDiagnostics.state,
          peerConnectionState: peerDiagnostics.peerConnectionState,
          dataChannelState: peerDiagnostics.dataChannelState,
          bytesSent: peerDiagnostics.bytesSent,
          bytesReceived: peerDiagnostics.bytesReceived,
        } : null,
        ...(peerDiagnosticsFailure ? { peerDiagnosticsFailure } : {}),
        evidenceBoundary: "failure snapshot only; observed DataChannel and ICE counters are not attributed to the failed RPC payload without the complete same-PC correlation gate",
      },
      quality: {
        allRttSucceeded,
        downloadHashVerified: download.hashVerified,
        downloadWithinBudget,
        routeExpectationMet: false,
        signedRouteDescriptorMatches,
        p2pDataPlaneVerified: false,
        sessionDataChannelCorrelationVerified: false,
        p2pIceConfigurationVerified: false,
        measurementComplete: false,
      },
    };
  } finally {
    rpc?.close();
    if (baseProfile) {
      releasePeerTransports(baseProfile);
      invalidateGatewayRoute(baseProfile);
    }
  }
}
function safeEndpoint(value: string): Record<string, unknown> | null {
  if (value.startsWith("kcoder-p2p:")) return { scheme: "kcoder-p2p:" };
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/^(\/g\/)[A-Za-z0-9_-]+(?=\/|$)/, "$1:id");
    return { scheme: url.protocol, host: url.hostname, port: url.port || null, path };
  } catch {
    return null;
  }
}

async function revokeBenchmarkDevice(publicBaseUrl: string, expectedDeviceId: string): Promise<Record<string, unknown>> {
  const profile = await findProfile(publicBaseUrl);
  const deviceId = profile.deviceId;
  if (!deviceId || deviceId !== expectedDeviceId) return { attempted: false, status: "fresh-device-identity-mismatch", retry: false };
  try {
    await revokeMobileDevice(profile, deviceId);
    return { attempted: true, status: "revoked", deviceIdentityPresent: true };
  } catch {
    return { attempted: true, status: "unknown-after-single-delete-attempt", deviceIdentityPresent: true, retry: false };
  }
}

benchmarkWindow.__runMobilePeerRouteBenchmark = runMobilePeerRouteBenchmark;
benchmarkWindow.__revokeMobilePeerRouteBenchmarkDevice = revokeBenchmarkDevice;
benchmarkWindow.__listMobilePeerRouteBenchmarkDeviceIdentities = listDeviceIdentities;
installRtcObserver();
