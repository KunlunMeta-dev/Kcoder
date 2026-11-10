import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import {
  decodedPeerChunkBytes,
  peerAnswerSignatureMessage,
  peerOfferProofMessage,
  type GatewayPeerFrame,
} from "../../../shared/gatewayPeerTransport.js";
import { decodePeerBase64, encodePeerBase64, encodePeerUtf8 } from "./peer-transport-bytes";
import type { PeerConnectionLike, PeerDataChannel, PeerEvent, PeerIceConfiguration, PeerSessionDescription } from "./peer-transport-platform.types";
import type { GatewayProfile } from "./types";

const randomState = vi.hoisted(() => ({ value: 0 }));

vi.mock("./connection-route-crypto", () => ({
  getGatewayRouteRandomBytes: async (count: number) => {
    randomState.value += 1;
    return new Uint8Array(count).fill(randomState.value & 0xff);
  },
}));

import {
  createPeerSocket,
  getPeerTransportDiagnostics,
  peerFetch,
  releasePeerTransports,
  tryCreatePeerTransport,
} from "./peer-transport";

const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const publicKeyBytes = ed25519.getPublicKey(privateKey);
const publicKey = toHex(publicKeyBytes);
const gatewayId = toHex(sha256(publicKeyBytes));
const endpoint = "https://gateway.example/g/peer-test";
const accessToken = "access-token-abcdefghijklmnopqrstuvwxyz012345";
const pairingToken = "pairing-token-abcdefghijklmnopqrstuvwxyz012345";
const createdProfiles: GatewayProfile[] = [];
const fakeConnections: FakePeerConnection[] = [];

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

class FakeDataChannel implements PeerDataChannel {
  label = "kcoder-gateway-v1";
  readyState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = "arraybuffer";
  sent: GatewayPeerFrame[] = [];
  onSend?: (frame: GatewayPeerFrame) => void;
  private readonly listeners = new Map<string, Set<(event: PeerEvent) => void>>();

  addEventListener(type: string, listener: (event: PeerEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set<(event: PeerEvent) => void>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: PeerEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(raw: string): void {
    const frame = JSON.parse(raw) as GatewayPeerFrame;
    this.sent.push(frame);
    if (frame.type === "ws.open") {
      this.receive({ version: 1, type: "ws.opened", id: frame.id, protocol: null });
    }
    this.onSend?.(frame);
  }

  receive(frame: GatewayPeerFrame): void {
    const event = { data: JSON.stringify(frame) };
    for (const listener of Array.from(this.listeners.get("message") ?? [])) listener(event);
  }

  close(): void {
    this.readyState = "closed";
    for (const listener of Array.from(this.listeners.get("close") ?? [])) listener({});
  }
}

class FakePeerConnection implements PeerConnectionLike {
  static nextCandidateTypes = { local: "host", remote: "srflx" };
  connectionState = "new";
  iceConnectionState = "new";
  iceGatheringState = "new";
  localDescription?: PeerSessionDescription | null;
  channel?: FakeDataChannel;
  readonly candidateTypes = { ...FakePeerConnection.nextCandidateTypes };
  closed = false;
  remoteDescriptionCalls = 0;
  onRemoteDescription?: () => void;
  private readonly listeners = new Map<string, Set<(event: PeerEvent) => void>>();

  constructor(readonly configuration: PeerIceConfiguration) {
    fakeConnections.push(this);
  }

  addEventListener(type: string, listener: (event: PeerEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set<(event: PeerEvent) => void>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: PeerEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  createDataChannel(label: string): FakeDataChannel {
    this.channel = new FakeDataChannel();
    this.channel.label = label;
    return this.channel;
  }

  async createOffer(): Promise<PeerSessionDescription> {
    return { type: "offer", sdp: "offer-sdp" };
  }

  async setLocalDescription(description: PeerSessionDescription): Promise<void> {
    this.localDescription = { ...description, sdp: "complete-offer-with-candidates" };
    this.iceGatheringState = "complete";
  }

  async setRemoteDescription(_description: PeerSessionDescription): Promise<void> {
    this.remoteDescriptionCalls += 1;
    this.onRemoteDescription?.();
    this.connectionState = "connected";
    this.iceConnectionState = "connected";
    if (this.channel) this.channel.readyState = "open";
  }

  async getStats(): Promise<unknown> {
    return new Map([
      ["transport", { id: "transport", type: "transport", selectedCandidatePairId: "pair" }],
      ["pair", { id: "pair", type: "candidate-pair", state: "succeeded", localCandidateId: "local", remoteCandidateId: "remote" }],
      ["local", { id: "local", type: "local-candidate", candidateType: this.candidateTypes.local }],
      ["remote", { id: "remote", type: "remote-candidate", candidateType: this.candidateTypes.remote }],
    ]);
  }

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
    this.channel?.close();
  }
}

function makeProfile(): GatewayProfile {
  const value: GatewayProfile = {
    id: "peer-transport-test-profile",
    label: "Peer transport test",
    baseUrl: endpoint,
    accessToken,
    expiresAt: Date.now() + 60_000,
    rpcToken: "rpc-token-must-not-be-used",
    authorizationGeneration: "generation-a",
    authMode: "device",
    deviceId: "device-a",
    connectionRoutes: {
      version: 1,
      gatewayId,
      publicKey,
      endpoints: [{ kind: "public", url: endpoint }],
    },
  };
  createdProfiles.push(value);
  return value;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installSignaling(options: { badSignature?: boolean } = {}) {
  const offers: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/mobile/p2p")) {
      return jsonResponse({ version: 1, gatewayId, stunUrls: ["stun:stun.example.org"] });
    }
    if (!url.endsWith("/api/mobile/p2p/offer") || init?.method !== "POST") return jsonResponse({}, 404);
    const offer = JSON.parse(String(init.body)) as Record<string, unknown>;
    offers.push(offer);
    const nonce = String(offer.nonce);
    const sdp = String(offer.offer);
    const offerHash = toHex(sha256(encodePeerUtf8(sdp)));
    const answer = "answer-sdp-with-candidates";
    const signature = options.badSignature
      ? "0".repeat(128)
      : toHex(ed25519.sign(encodePeerUtf8(peerAnswerSignatureMessage(gatewayId, nonce, offerHash, answer)), privateKey));
    return jsonResponse({ version: 1, gatewayId, nonce, offerHash, answer, signature });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, offers };
}

async function establish(profile = makeProfile(), auth?: { kind: "pairing" | "access"; token: string }) {
  const url = await tryCreatePeerTransport(profile, profile.connectionRoutes, endpoint, auth ? { auth } : {});
  expect(url).toMatch(/^kcoder-p2p:\/\/[a-f0-9]{48}$/);
  const connection = fakeConnections.at(-1)!;
  return { url: url!, profile, connection, channel: connection.channel! };
}

async function waitForSocketOpen(channel: FakeDataChannel): Promise<Extract<GatewayPeerFrame, { type: "ws.open" }>> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const frame = channel.sent.find((item): item is Extract<GatewayPeerFrame, { type: "ws.open" }> => item.type === "ws.open");
    if (frame) return frame;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error("WebSocket open frame was not sent");
}

function peerFrame(type: "ws.message.start", id: string, messageId: string, byteLength: number): GatewayPeerFrame;
function peerFrame(type: "ws.message.chunk", id: string, messageId: string, seq: number, data: string): GatewayPeerFrame;
function peerFrame(type: "ws.message.end", id: string, messageId: string): GatewayPeerFrame;
function peerFrame(type: string, id: string, messageId: string, value?: number | string, data?: string): GatewayPeerFrame {
  if (type === "ws.message.start") return { version: 1, type, id, messageId, binary: false, byteLength: value as number };
  if (type === "ws.message.chunk") return { version: 1, type, id, messageId, seq: value as number, data: data! };
  return { version: 1, type: "ws.message.end", id, messageId };
}

beforeEach(() => {
  fakeConnections.length = 0;
  FakePeerConnection.nextCandidateTypes = { local: "host", remote: "srflx" };
  randomState.value = 0;
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
});

afterEach(() => {
  for (const profile of createdProfiles.splice(0)) releasePeerTransports(profile);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Mobile P2P gateway transport", () => {
  it("keeps legacy browser credentials on Relay without sending an unsupported peer offer", async () => {
    const legacy = { ...makeProfile(), authMode: "legacy" as const };
    const request = vi.fn(); vi.stubGlobal("fetch", request);
    await expect(tryCreatePeerTransport(legacy, legacy.connectionRoutes, endpoint)).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
  it("verifies signed signaling and sends only token-scoped HMAC proof before opening the channel", async () => {
    const profile = makeProfile();
    const { fetchMock, offers } = installSignaling();
    const { url, connection, channel } = await establish(profile, { kind: "pairing", token: pairingToken });

    expect(connection.remoteDescriptionCalls).toBe(1);
    expect(channel.label).toBe("kcoder-gateway-v1");
    expect(channel.readyState).toBe("open");
    expect(connection.configuration).toEqual({
      iceServers: [{ urls: "stun:stun.example.org" }],
      iceTransportPolicy: "all",
    });
    expect(offers).toHaveLength(1);
    const offer = offers[0]!;
    expect(offer).toMatchObject({ version: 1, offer: "complete-offer-with-candidates" });
    expect(String(JSON.stringify(offer))).not.toContain(pairingToken);
    const auth = offer.auth as { kind: string; keyId: string; proof: string };
    const offerHash = toHex(sha256(encodePeerUtf8(String(offer.offer))));
    expect(auth).toEqual({
      kind: "pairing",
      keyId: toHex(sha256(encodePeerUtf8(pairingToken))),
      proof: toHex(hmac(sha256, encodePeerUtf8(pairingToken), encodePeerUtf8(peerOfferProofMessage(gatewayId, String(offer.nonce), offerHash)))),
    });
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("error");
    }
    await expect(getPeerTransportDiagnostics(url)).resolves.toMatchObject({
      state: "open",
      platform: "web",
      localCandidateType: "host",
      remoteCandidateType: "srflx",
    });
  });

  it("does not apply an unsigned answer and closes the owned setup resources", async () => {
    installSignaling({ badSignature: true });
    const profile = makeProfile();
    await expect(tryCreatePeerTransport(profile, profile.connectionRoutes, endpoint)).resolves.toBeUndefined();
    expect(fakeConnections).toHaveLength(1);
    expect(fakeConnections[0]!.remoteDescriptionCalls).toBe(0);
    expect(fakeConnections[0]!.closed).toBe(true);
    expect(fakeConnections[0]!.channel?.readyState).toBe("closed");
  });

  it("does not publish a session when the profile authorization scope changes during negotiation", async () => {
    installSignaling();
    const profile = makeProfile();
    const connectionHook = () => { profile.authorizationGeneration = "generation-b"; };
    const originalCreateDataChannel = FakePeerConnection.prototype.createDataChannel;
    vi.spyOn(FakePeerConnection.prototype, "createDataChannel").mockImplementation(function (this: FakePeerConnection, label: string) {
      const channel = originalCreateDataChannel.call(this, label);
      this.onRemoteDescription = connectionHook;
      return channel;
    });

    await expect(tryCreatePeerTransport(profile, profile.connectionRoutes, endpoint)).resolves.toBeUndefined();
    expect(fakeConnections[0]!.closed).toBe(true);
    expect(fakeConnections[0]!.channel?.readyState).toBe("closed");
  });

  it("rejects a selected relay candidate pair", async () => {
    installSignaling();
    FakePeerConnection.nextCandidateTypes = { local: "relay", remote: "host" };
    const profile = makeProfile();

    await expect(tryCreatePeerTransport(profile, profile.connectionRoutes, endpoint)).resolves.toBeUndefined();
    expect(fakeConnections[0]!.closed).toBe(true);
  });

  it("streams HTTP responses and releases the operation after the body is consumed", async () => {
    installSignaling();
    const { url, channel } = await establish();
    channel.onSend = frame => {
      if (frame.type !== "http.request.end") return;
      const bytes = encodePeerUtf8("hello");
      channel.receive({ version: 1, type: "http.response.start", id: frame.id, status: 200, headers: { "content-type": "text/plain" }, bodyLength: bytes.byteLength });
      channel.receive({ version: 1, type: "http.response.chunk", id: frame.id, seq: 0, data: encodePeerBase64(bytes) });
      channel.receive({ version: 1, type: "http.response.end", id: frame.id });
    };

    const response = await peerFetch(url + "/api/mobile/devices", {
      method: "GET",
      headers: { authorization: "Bearer " + "a".repeat(32) },
    });
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("hello");
    await expect(getPeerTransportDiagnostics(url)).resolves.toMatchObject({ activeOperations: 0 });
  });

  it("bounds an unread HTTP response stream to one MiB and closes an overflowing session", async () => {
    installSignaling();
    const { url, channel, connection } = await establish();
    channel.onSend = frame => {
      if (frame.type !== "http.request.end") return;
      const chunk = encodePeerBase64(new Uint8Array(8192));
      channel.receive({ version: 1, type: "http.response.start", id: frame.id, status: 200, headers: {}, bodyLength: 1024 * 1024 + 1 });
      for (let sequence = 0; sequence < 129; sequence += 1) {
        channel.receive({ version: 1, type: "http.response.chunk", id: frame.id, seq: sequence, data: chunk });
        if (connection.closed) break;
      }
    };

    const response = await peerFetch(url + "/api/mobile/devices", {
      method: "GET",
      headers: { authorization: "Bearer " + "a".repeat(32) },
    });
    expect(response.status).toBe(200);
    expect(connection.closed).toBe(true);
    await expect(getPeerTransportDiagnostics(url)).resolves.toBeUndefined();
  });

  it("cancels an HTTP POST without sending remaining body chunks", async () => {
    installSignaling();
    const { url, channel } = await establish();
    const controller = new AbortController();
    channel.onSend = frame => {
      if (frame.type === "http.request.start") controller.abort();
    };

    await expect(peerFetch(url + "/api/mobile/session", {
      method: "POST",
      body: "x".repeat(20_000),
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(channel.sent.some(frame => frame.type === "http.cancel")).toBe(true);
    expect(channel.sent.some(frame => frame.type === "http.request.chunk" || frame.type === "http.request.end")).toBe(false);
  });

  it("assembles a normal multi-chunk WebSocket message and bounds empty assemblies", async () => {
    installSignaling();
    const { url, channel, connection } = await establish();
    const socket = createPeerSocket(url + "/rpc?token=" + "r".repeat(32), [], {
      authorization: "Bearer " + "a".repeat(32),
    });
    const opened = await waitForSocketOpen(channel);
    const socketId = opened.id;
    expect(opened.protocols).toEqual([]);
    const messages: unknown[] = [];
    socket.onmessage = event => messages.push(event.data);
    const content = encodePeerUtf8("hello");
    const middle = Math.floor(content.byteLength / 2);
    channel.receive(peerFrame("ws.message.start", socketId, "normal-message", content.byteLength));
    channel.receive(peerFrame("ws.message.chunk", socketId, "normal-message", 0, encodePeerBase64(content.subarray(0, middle))));
    channel.receive(peerFrame("ws.message.chunk", socketId, "normal-message", 1, encodePeerBase64(content.subarray(middle))));
    channel.receive(peerFrame("ws.message.end", socketId, "normal-message"));
    expect(messages).toEqual(["hello"]);
    expect(decodedPeerChunkBytes(encodePeerBase64(content))).toBe(content.byteLength);

    for (let index = 0; index < 8; index += 1) {
      channel.receive(peerFrame("ws.message.start", socketId, "empty" + index, 0));
    }
    expect(socket.readyState).toBe(socket.OPEN);
    channel.receive(peerFrame("ws.message.start", socketId, "empty-overflow", 0));
    expect(connection.closed).toBe(true);
    expect(socket.readyState).toBe(socket.CLOSED);
  });

  it("rejects empty WebSocket chunks", async () => {
    installSignaling();
    const { url, channel, connection } = await establish();
    const socket = createPeerSocket(url + "/rpc?token=" + "r".repeat(32), [], {
      authorization: "Bearer " + "a".repeat(32),
    });
    const opened = await waitForSocketOpen(channel);
    expect(opened.protocols).toEqual([]);
    channel.receive(peerFrame("ws.message.start", opened.id, "empty-chunk-test", 1));
    channel.receive({
      version: 1,
      type: "ws.message.chunk",
      id: opened.id,
      messageId: "empty-chunk-test",
      seq: 0,
      data: "",
    } as GatewayPeerFrame);
    expect(connection.closed).toBe(true);
    expect(socket.readyState).toBe(socket.CLOSED);
  });
});
