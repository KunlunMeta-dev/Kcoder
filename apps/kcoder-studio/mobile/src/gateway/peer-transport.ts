import { ed25519 } from "@noble/curves/ed25519";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import {
  canonicalGatewayConnectionUrl,
  parseGatewayConnectionRoutes,
  type GatewayConnectionRoutes,
} from "../../../shared/gatewayConnectionRoutes.js";
import {
  PEER_BUFFER_HIGH_WATERMARK,
  PEER_CHANNEL_LABEL,
  PEER_CHUNK_BYTES,
  PEER_MAX_OPERATIONS,
  PEER_MESSAGE_BYTES,
  PEER_TRANSPORT_VERSION,
  decodedPeerChunkBytes,
  encodePeerFrame,
  parsePeerFrame,
  peerAnswerSignatureMessage,
  peerOfferProofMessage,
  type GatewayPeerFrame,
  type GatewayPeerHttpHeaders,
} from "../../../shared/gatewayPeerTransport.js";
import type { GatewayProfile } from "./types";
import {
  copyPeerBytes,
  decodePeerBase64,
  decodePeerUtf8,
  encodePeerBase64,
  encodePeerUtf8,
  peerBytesToArrayBuffer,
} from "./peer-transport-bytes";
import {
  createPlatformPeerConnection,
  PEER_PLATFORM_NATIVE,
  setPlatformRemoteDescription,
} from "./peer-transport-platform";
import type {
  PeerConnectionLike,
  PeerDataChannel,
  PeerEvent,
  PeerIceConfiguration,
  PeerSessionDescription,
} from "./peer-transport-platform.types";

const HANDSHAKE_BUDGET_MS = 8_000;
const SIGNALING_RESPONSE_BYTES = 128 * 1024;
const MAX_STUN_SERVERS = 8;
const MAX_STUN_URL_LENGTH = 512;
const MAX_BUFFERED_RECEIVE_BYTES = 1024 * 1024;
const DRAIN_TIMEOUT_MS = 10_000;
const OPERATION_TIMEOUT_MS = 30_000;
const PEER_URL_PREFIX = "kcoder-p2p://";
const HEX_24 = /^[a-f0-9]{48}$/;
const HEX_32 = /^[a-f0-9]{64}$/;
const HEX_64 = /^[a-f0-9]{128}$/;
const HTTP_REQUEST_HEADERS = new Set([
  "authorization", "content-type", "accept", "if-match", "if-none-match",
  "range", "content-range",
]);
const RESPONSE_HEADERS = new Set([
  "content-type", "cache-control", "etag", "last-modified", "content-range",
  "accept-ranges", "retry-after", "access-control-allow-origin", "vary",
  "x-content-type-options", "allow",
]);
const FORBIDDEN_RESPONSE_BODY_STATUS = new Set([204, 205, 304]);

type AuthKind = "pairing" | "access";

export interface PeerTransportOptions {
  signal?: AbortSignal;
  auth?: { kind: AuthKind; token: string };
}

export interface PeerTransportReleaseScope {
  profileId: string;
  baseUrl: string;
  deviceId?: string;
  authorizationGeneration?: string;
  authMode?: "device" | "legacy";
}

export interface PeerTransportDiagnostics {
  state: "connecting" | "open" | "closed";
  peerConnectionState: string;
  dataChannelState: string;
  localCandidateType?: string;
  remoteCandidateType?: string;
  bytesSent: number;
  bytesReceived: number;
  activeOperations: number;
  platform: "web" | "native";
}

type Operation = HttpOperation | PeerWebSocket;

interface HttpOperation {
  kind: "http";
  id: string;
  responseStatus?: number;
  responseHeaders?: GatewayPeerHttpHeaders;
  responseExpectedLength: number | null;
  responseReceived: number;
  responseSequence: number;
  responseController?: ReadableStreamDefaultController<Uint8Array>;
  responsePullPending: boolean;
  responseChunks: Uint8Array[];
  resolveResponse: (response: Response) => void;
  rejectResponse: (error: Error) => void;
  responseStarted: boolean;
  responseEnded: boolean;
  receiveBytesPending: number;
  abortCleanup?: () => void;
  timer: ReturnType<typeof setTimeout>;
}

interface InboundSocketMessage {
  binary: boolean;
  expectedLength: number;
  receivedLength: number;
  nextSequence: number;
  bytes: Uint8Array;
}

interface SocketEventLike {
  type: string;
  target: PeerWebSocket;
  currentTarget: PeerWebSocket;
  data?: unknown;
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

export class PeerWebSocket {
  readonly kind = "ws";
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = PeerWebSocket.CONNECTING;
  readonly OPEN = PeerWebSocket.OPEN;
  readonly CLOSING = PeerWebSocket.CLOSING;
  readonly CLOSED = PeerWebSocket.CLOSED;
  readonly url: string;
  binaryType: BinaryType = "arraybuffer";
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  readyState = PeerWebSocket.CONNECTING;
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  private readonly inboundMessages = new Map<string, InboundSocketMessage>();
  private readonly outboundMessageIds = new Set<string>();
  private pendingOutboundMessages = 0;
  private closeRequested = false;
  private closedEventSent = false;

  constructor(
    private readonly session: PeerSession,
    readonly id: string,
    url: string,
    private readonly requestedProtocols: string[],
    private readonly authorization: string | null,
    path: string,
  ) {
    this.url = url;
    session.operations.set(id, this);
    session.sendFrame({
      version: PEER_TRANSPORT_VERSION,
      type: "ws.open",
      id,
      path,
      authorization,
      protocols: requestedProtocols,
    }, () => session.operations.get(id) === this)
      .catch(error => this.fail(error instanceof Error ? error : new Error("P2P WebSocket open failed")));
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (!listener) return;
    const set = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (!listener) return;
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    this.emit(event.type, { suppliedEvent: event });
    return !event.defaultPrevented;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    if (this.readyState === PeerWebSocket.CONNECTING) throw stateError("WebSocket is still connecting");
    if (this.readyState !== PeerWebSocket.OPEN) throw stateError("WebSocket is not open");
    if (this.pendingOutboundMessages >= PEER_MAX_OPERATIONS) {
      throw new RangeError("Too many queued P2P WebSocket messages");
    }
    this.pendingOutboundMessages += 1;
    const send = async () => {
      let bytes: Uint8Array;
      let binary: boolean;
      if (typeof data === "string") {
        bytes = encodePeerUtf8(data);
        binary = false;
      } else if (typeof Blob !== "undefined" && data instanceof Blob) {
        bytes = new Uint8Array(await data.arrayBuffer());
        binary = true;
      } else if (data instanceof ArrayBuffer) {
        bytes = new Uint8Array(data.slice(0));
        binary = true;
      } else if (ArrayBuffer.isView(data)) {
        bytes = copyPeerBytes(data);
        binary = true;
      } else {
        throw new TypeError("Unsupported peer WebSocket payload");
      }
      if (bytes.byteLength > PEER_MESSAGE_BYTES) throw new RangeError("P2P WebSocket message exceeds 16 MiB");
      const messageId = await randomHex(12);
      if (this.session.outboundAssemblyCount >= PEER_MAX_OPERATIONS ||
          this.session.outboundBytes + bytes.byteLength > PEER_MESSAGE_BYTES) {
        throw new RangeError("P2P WebSocket queued message budget exceeded");
      }
      this.session.outboundAssemblyCount += 1;
      this.session.outboundBytes += bytes.byteLength;
      this.outboundMessageIds.add(messageId);
      this.bufferedAmount += bytes.byteLength;
      try {
        await this.session.sendFrame({
          version: PEER_TRANSPORT_VERSION,
          type: "ws.message.start",
          id: this.id,
          messageId,
          binary,
          byteLength: bytes.byteLength,
        }, () => this.session.operations.get(this.id) === this && this.readyState === PeerWebSocket.OPEN);
        let sequence = 0;
        for (let offset = 0; offset < bytes.byteLength; offset += PEER_CHUNK_BYTES) {
          await this.session.sendFrame({
            version: PEER_TRANSPORT_VERSION,
            type: "ws.message.chunk",
            id: this.id,
            messageId,
            seq: sequence++,
            data: encodePeerBase64(bytes.subarray(offset, Math.min(offset + PEER_CHUNK_BYTES, bytes.byteLength))),
          }, () => this.session.operations.get(this.id) === this && this.readyState === PeerWebSocket.OPEN);
        }
        await this.session.sendFrame({
          version: PEER_TRANSPORT_VERSION,
          type: "ws.message.end",
          id: this.id,
          messageId,
        }, () => this.session.operations.get(this.id) === this && this.readyState === PeerWebSocket.OPEN);
      } catch (error) {
        if (this.readyState === PeerWebSocket.OPEN) {
          this.fail(error instanceof Error ? error : new Error("P2P WebSocket send failed"));
        }
      } finally {
        this.outboundMessageIds.delete(messageId);
        this.bufferedAmount = Math.max(0, this.bufferedAmount - bytes.byteLength);
        this.session.outboundAssemblyCount = Math.max(0, this.session.outboundAssemblyCount - 1);
        this.session.outboundBytes = Math.max(0, this.session.outboundBytes - bytes.byteLength);
      }
    };
    void send().catch(error => {
      if (this.readyState === PeerWebSocket.OPEN) {
        this.fail(error instanceof Error ? error : new Error("P2P WebSocket send failed"));
      }
    }).finally(() => {
      this.pendingOutboundMessages = Math.max(0, this.pendingOutboundMessages - 1);
    });
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === PeerWebSocket.CLOSED || this.readyState === PeerWebSocket.CLOSING) return;
    if (!validCloseCode(code) || encodePeerUtf8(reason).byteLength > 123) throw new TypeError("Invalid WebSocket close arguments");
    this.closeRequested = true;
    this.readyState = PeerWebSocket.CLOSING;
    void this.session.sendFrame({
      version: PEER_TRANSPORT_VERSION,
      type: "ws.close",
      id: this.id,
      code,
      reason,
    }, () => this.session.operations.get(this.id) === this && this.readyState === PeerWebSocket.CLOSING)
      .catch(error => this.fail(error instanceof Error ? error : new Error("P2P WebSocket close failed")));
  }

  handleOpened(protocol: string | null): void {
    if (this.readyState !== PeerWebSocket.CONNECTING) return;
    this.protocol = protocol ?? "";
    this.readyState = PeerWebSocket.OPEN;
    this.emit("open");
  }

  handleMessageStart(messageId: string, binary: boolean, byteLength: number): void {
    if (this.readyState !== PeerWebSocket.OPEN || byteLength > PEER_MESSAGE_BYTES || this.inboundMessages.has(messageId)) {
      this.session.fail(new Error("Invalid P2P WebSocket message start"));
      return;
    }
    if (this.session.inboundBytes + byteLength > PEER_MESSAGE_BYTES) {
      this.session.fail(new Error("P2P WebSocket receive buffer exceeded"));
      return;
    }
    if (this.session.inboundAssemblyCount >= PEER_MAX_OPERATIONS) {
      this.session.fail(new Error("Too many incomplete P2P WebSocket messages"));
      return;
    }
    try {
      this.inboundMessages.set(messageId, {
        binary,
        expectedLength: byteLength,
        receivedLength: 0,
        nextSequence: 0,
        bytes: new Uint8Array(byteLength),
      });
      this.session.inboundBytes += byteLength;
      this.session.inboundAssemblyCount += 1;
    } catch {
      this.session.fail(new Error("P2P WebSocket receive allocation failed"));
    }
  }

  handleMessageChunk(messageId: string, sequence: number, data: string): void {
    const message = this.inboundMessages.get(messageId);
    if (!message || sequence !== message.nextSequence) {
      this.session.fail(new Error("Invalid P2P WebSocket message sequence"));
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = decodePeerBase64(data);
      if (bytes.byteLength === 0 || decodedPeerChunkBytes(data) !== bytes.byteLength) throw new Error("Invalid base64 chunk");
    } catch {
      this.session.fail(new Error("Invalid P2P WebSocket message chunk"));
      return;
    }
    message.receivedLength += bytes.byteLength;
    if (message.receivedLength > message.expectedLength) {
      this.session.fail(new Error("P2P WebSocket receive buffer exceeded"));
      return;
    }
    message.bytes.set(bytes, message.receivedLength - bytes.byteLength);
    message.nextSequence += 1;
  }

  handleMessageEnd(messageId: string): void {
    const message = this.inboundMessages.get(messageId);
    if (!message || message.receivedLength !== message.expectedLength) {
      this.session.fail(new Error("Incomplete P2P WebSocket message"));
      return;
    }
    this.inboundMessages.delete(messageId);
    this.session.inboundBytes -= message.expectedLength;
    this.session.inboundAssemblyCount = Math.max(0, this.session.inboundAssemblyCount - 1);
    const bytes = message.bytes;
    const data = message.binary
      ? peerBytesToArrayBuffer(bytes)
      : decodePeerUtf8(bytes);
    this.emit("message", { data });
  }

  handleClosed(code: number, reason: string): void {
    this.clearInboundMessages();
    this.readyState = PeerWebSocket.CLOSED;
    this.session.operations.delete(this.id);
    this.emitClose(code, reason, this.closeRequested || code === 1000);
  }

  handleRemoteError(code: string): void {
    this.fail(new Error("Gateway peer WebSocket error: " + code));
  }

  fail(error: Error): void {
    if (this.readyState === PeerWebSocket.CLOSED) return;
    this.clearInboundMessages();
    this.session.operations.delete(this.id);
    this.readyState = PeerWebSocket.CLOSED;
    this.emit("error", { message: error.message });
    this.emitClose(1006, "", false);
  }

  private clearInboundMessages(): void {
    for (const message of this.inboundMessages.values()) {
      this.session.inboundBytes -= message.expectedLength;
      this.session.inboundAssemblyCount -= 1;
    }
    this.inboundMessages.clear();
    this.session.inboundBytes = Math.max(0, this.session.inboundBytes);
    this.session.inboundAssemblyCount = Math.max(0, this.session.inboundAssemblyCount);
  }

  private emitClose(code: number, reason: string, wasClean: boolean): void {
    if (this.closedEventSent) return;
    this.closedEventSent = true;
    this.emit("close", { code, reason, wasClean });
  }

  private emit(type: string, extra: Record<string, unknown> = {}): void {
    const event = {
      type,
      target: this,
      currentTarget: this,
      ...extra,
    } as unknown as SocketEventLike;
    const handler = type === "open" ? this.onopen
      : type === "message" ? this.onmessage
        : type === "error" ? this.onerror
          : type === "close" ? this.onclose
            : null;
    try {
      (handler as ((event: unknown) => unknown) | null)?.(event);
    } catch {
      // Match browser EventTarget behavior: user listener exceptions do not corrupt the transport.
    }
    for (const listener of Array.from(this.listeners.get(type) ?? [])) {
      try {
        if (typeof listener === "function") listener(event as unknown as Event);
        else listener.handleEvent(event as unknown as Event);
      } catch {
        // Match browser EventTarget behavior.
      }
    }
  }
}

interface PeerSession {
  readonly id: string;
  readonly url: string;
  readonly familyKey: string;
  readonly scope: PeerTransportReleaseScope;
  readonly authKind: AuthKind;
  readonly keyId: string;
  readonly gatewayId: string;
  readonly publicKey: string;
  readonly endpoint: string;
  readonly createdAt: number;
  readonly peerConnection: PeerConnectionLike;
  readonly dataChannel: PeerDataChannel;
  readonly operations: Map<string, Operation>;
  sendQueue: Promise<void>;
  dead: boolean;
  closing: boolean;
  bytesSent: number;
  bytesReceived: number;
  localCandidateType?: string;
  remoteCandidateType?: string;
  inboundBytes: number;
  inboundAssemblyCount: number;
  outboundBytes: number;
  outboundAssemblyCount: number;
  pendingResponseBytes: number;
  fail(error: Error): void;
  sendFrame(frame: GatewayPeerFrame, canSend?: () => boolean): Promise<void>;
}

interface SessionFlight {
  controller: AbortController;
  promise: Promise<PeerSession | undefined>;
  waiters: number;
  scope: PeerTransportReleaseScope;
  familyKey: string;
}

const sessionsByUrl = new Map<string, PeerSession>();
const sessionsByFamily = new Map<string, PeerSession>();
const sessionFlights = new Map<string, SessionFlight>();
let peerSocketSequence = 0;

function stateError(message: string): DOMException | Error {
  if (typeof DOMException !== "undefined") return new DOMException(message, "InvalidStateError");
  const error = new Error(message);
  error.name = "InvalidStateError";
  return error;
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function awaitWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onLateValue?: (value: T) => void,
): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        if (settled) {
          onLateValue?.(value);
          return;
        }
        settled = true;
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
  });
}

function hex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}

function fromHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function randomHex(byteCount: number): Promise<string> {
  return hex(await getGatewayRouteRandomBytes(byteCount));
}

async function getGatewayRouteRandomBytes(byteCount: number): Promise<Uint8Array> {
  const { getGatewayRouteRandomBytes: getBytes } = await import("./connection-route-crypto");
  return getBytes(byteCount);
}

function profileScope(profile: GatewayProfile): PeerTransportReleaseScope {
  return {
    profileId: profile.id,
    baseUrl: profile.baseUrl,
    ...(profile.deviceId !== undefined ? { deviceId: profile.deviceId } : {}),
    ...(profile.authorizationGeneration !== undefined
      ? { authorizationGeneration: profile.authorizationGeneration }
      : {}),
    authMode: profile.authMode ?? "legacy",
  };
}

function scopeIdentity(scope: PeerTransportReleaseScope): string {
  return JSON.stringify([
    scope.profileId,
    scope.baseUrl,
    scope.deviceId ?? "",
    scope.authorizationGeneration ?? "legacy:" + scope.profileId,
    scope.authMode ?? "legacy",
  ]);
}

function normalizedReleaseScope(value: GatewayProfile | PeerTransportReleaseScope): PeerTransportReleaseScope | undefined {
  if (!value || typeof value !== "object" || "id" in value) {
    const profile = value as GatewayProfile;
    if (typeof profile.id !== "string" || typeof profile.baseUrl !== "string") return undefined;
    return profileScope(profile);
  }
  const scope = value as PeerTransportReleaseScope;
  if (typeof scope.profileId !== "string" || typeof scope.baseUrl !== "string") return undefined;
  return {
    profileId: scope.profileId,
    baseUrl: scope.baseUrl,
    ...(scope.deviceId !== undefined ? { deviceId: scope.deviceId } : {}),
    ...(scope.authorizationGeneration !== undefined
      ? { authorizationGeneration: scope.authorizationGeneration }
      : {}),
    ...(scope.authMode !== undefined ? { authMode: scope.authMode } : {}),
  };
}

function sameReleaseOwner(session: PeerSession, scope: PeerTransportReleaseScope): boolean {
  return session.scope.profileId === scope.profileId &&
    session.scope.baseUrl === scope.baseUrl &&
    (scope.deviceId === undefined || session.scope.deviceId === scope.deviceId) &&
    (scope.authorizationGeneration === undefined ||
      session.scope.authorizationGeneration === scope.authorizationGeneration) &&
    (scope.authMode === undefined || session.scope.authMode === scope.authMode);
}

function familyKey(
  profile: GatewayProfile,
  descriptor: GatewayConnectionRoutes,
  endpoint: string,
  authKind: AuthKind,
): string {
  return JSON.stringify([
    profile.id,
    profile.baseUrl,
    profile.deviceId ?? "",
    profile.authorizationGeneration ?? "legacy:" + profile.id,
    profile.authMode ?? "legacy",
    descriptor.gatewayId,
    descriptor.publicKey,
    endpoint,
    authKind,
  ]);
}

function acceptableSignalUrl(endpoint: string): boolean {
  let target: URL;
  try {
    target = new URL(endpoint);
  } catch {
    return false;
  }
  if (target.username || target.password || target.search || target.hash) return false;
  if (typeof globalThis.location !== "undefined" && globalThis.location.protocol === "https:" &&
      target.protocol !== "https:") return false;
  if (!PEER_PLATFORM_NATIVE && typeof globalThis.location !== "undefined" &&
      globalThis.location.protocol !== "http:" && target.protocol !== "https:") return false;
  if (PEER_PLATFORM_NATIVE && target.protocol !== "https:") {
    const developmentHttpAllowed = process.env.KCODER_STUDIO_ALLOW_HTTP === "1" &&
      process.env.EXPO_PUBLIC_KCODER_STUDIO_ALLOW_HTTP === "1";
    if (!developmentHttpAllowed || target.protocol !== "http:") return false;
  }
  return target.protocol === "https:" || target.protocol === "http:";
}

function validStunUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STUN_URL_LENGTH ||
      /[\s/@?#\\]/.test(value)) return false;
  const match = /^(stun|stuns):(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(value);
  if (!match) return false;
  const host = match[2]!;
  if (host.startsWith("[") && !host.endsWith("]")) return false;
  if (!host.startsWith("[") &&
      (host.startsWith(".") || host.endsWith(".") || host.includes(".."))) return false;
  if (match[3] !== undefined) {
    const port = Number(match[3]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  }
  return true;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

async function readBoundedJson(response: Response, maximumBytes: number, signal?: AbortSignal): Promise<unknown> {
  throwIfAborted(signal);
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null &&
      (!/^\d+$/.test(contentLength) || Number(contentLength) > maximumBytes)) {
    throw new Error("P2P signaling response too large");
  }
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const result = signal ? await awaitWithSignal(reader.read(), signal) : await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > maximumBytes) {
          void reader.cancel().catch(() => {});
          throw new Error("P2P signaling response too large");
        }
        chunks.push(result.value);
      }
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(decodePeerUtf8(joinBytes(chunks, size))) as unknown;
  }
  const raw = signal
    ? await awaitWithSignal(response.text(), signal, () => { void response.body?.cancel().catch(() => {}); })
    : await response.text();
  if (encodePeerUtf8(raw).byteLength > maximumBytes) throw new Error("P2P signaling response too large");
  return JSON.parse(raw) as unknown;
}

async function getPeerConfig(endpoint: string, signal: AbortSignal, expectedGatewayId: string): Promise<string[] | undefined> {
  let response: Response;
  try {
    response = await awaitWithSignal(fetch(endpoint + "/api/mobile/p2p", {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json" },
      signal,
    }), signal, lateResponse => { void lateResponse.body?.cancel(); });
  } catch {
    return undefined;
  }
  if (response.status === 404) return undefined;
  if (!response.ok) return undefined;
  try {
    const value = await readBoundedJson(response, SIGNALING_RESPONSE_BYTES, signal);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const config = value as Record<string, unknown>;
    if (!exactKeys(config, ["version", "gatewayId", "stunUrls"]) ||
        config.version !== 1 || config.gatewayId !== expectedGatewayId ||
        !Array.isArray(config.stunUrls) || config.stunUrls.length > MAX_STUN_SERVERS ||
        config.stunUrls.some(url => !validStunUrl(url)) ||
        new Set(config.stunUrls).size !== config.stunUrls.length) return undefined;
    return config.stunUrls as string[];
  } catch {
    return undefined;
  }
}

function waitForEvent(
  target: { addEventListener?(type: string, listener: (event: PeerEvent) => void): void; removeEventListener?(type: string, listener: (event: PeerEvent) => void): void },
  type: string,
  predicate: () => boolean,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  throwIfAborted(signal);
  if (predicate()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let finished = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      target.removeEventListener?.(type, onEvent);
    };
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onEvent = () => {
      if (predicate()) finish();
    };
    const onAbort = () => finish(abortError());
    const timer = setTimeout(() => finish(new Error("P2P handshake timed out")), timeoutMs);
    target.addEventListener?.(type, onEvent);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    if (predicate()) finish();
  });
}

function assignEvent(target: object, type: string, listener: (event: PeerEvent) => void): () => void {
  const eventTarget = target as {
    addEventListener?: (event: string, handler: (event: PeerEvent) => void) => void;
    removeEventListener?: (event: string, handler: (event: PeerEvent) => void) => void;
    [key: string]: unknown;
  };
  if (typeof eventTarget.addEventListener === "function") {
    eventTarget.addEventListener(type, listener);
    return () => eventTarget.removeEventListener?.(type, listener);
  }
  const property = "on" + type;
  const previous = eventTarget[property];
  eventTarget[property] = (event: PeerEvent) => {
    if (typeof previous === "function") (previous as (value: PeerEvent) => void)(event);
    listener(event);
  };
  return () => {
    if (eventTarget[property] !== previous) eventTarget[property] = previous;
  };
}

function candidateTypesFromStats(value: unknown): { local?: string; remote?: string } {
  const records: Record<string, unknown>[] = [];
  const stats = value as { forEach?: (callback: (record: Record<string, unknown>) => void) => void };
  if (stats && typeof stats.forEach === "function") {
    stats.forEach(record => records.push(record));
  } else if (Array.isArray(value)) {
    for (const item of value) if (item && typeof item === "object") records.push(item as Record<string, unknown>);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) if (item && typeof item === "object") records.push(item as Record<string, unknown>);
  }
  const byId = new Map(records.filter(record => typeof record.id === "string").map(record => [record.id as string, record]));
  const transports = records.filter(record => record.type === "transport");
  let pair: Record<string, unknown> | undefined;
  for (const transport of transports) {
    const selectedId = transport.selectedCandidatePairId;
    if (typeof selectedId === "string") {
      pair = byId.get(selectedId);
      if (pair) break;
    }
  }
  if (!pair) {
    pair = records.find(record => record.type === "candidate-pair" &&
      (record.selected === true || record.nominated === true) && record.state === "succeeded");
  }
  if (!pair) return {};
  const local = typeof pair.localCandidateId === "string" ? byId.get(pair.localCandidateId) : undefined;
  const remote = typeof pair.remoteCandidateId === "string" ? byId.get(pair.remoteCandidateId) : undefined;
  return {
    ...(typeof local?.candidateType === "string" ? { local: local.candidateType } : {}),
    ...(typeof remote?.candidateType === "string" ? { remote: remote.candidateType } : {}),
  };
}

async function waitForDirectPeer(connection: PeerConnectionLike, channel: PeerDataChannel, signal: AbortSignal): Promise<{ local?: string; remote?: string }> {
  const deadline = Date.now() + HANDSHAKE_BUDGET_MS;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (connection.connectionState === "failed" || connection.iceConnectionState === "failed" ||
        channel.readyState === "closed") throw new Error("P2P connection failed");
    if (connection.connectionState === "connected" && channel.readyState === "open") {
      try {
        const candidates = candidateTypesFromStats(await awaitWithSignal(connection.getStats(), signal));
        const directTypes = new Set(["host", "srflx", "prflx"]);
        if (candidates.local && candidates.remote) {
          if (directTypes.has(candidates.local) && directTypes.has(candidates.remote)) return candidates;
          throw new Error("P2P relay candidate pair is forbidden");
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("forbidden")) throw error;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error("P2P direct connection timed out");
}

function validateDescriptor(
  descriptorValue: unknown,
  endpointValue: string,
): { descriptor: GatewayConnectionRoutes; endpoint: string } | undefined {
  const descriptor = parseGatewayConnectionRoutes(descriptorValue);
  const endpoint = canonicalGatewayConnectionUrl(endpointValue);
  if (!descriptor || !endpoint || !acceptableSignalUrl(endpoint)) return undefined;
  const publicEndpoint = descriptor.endpoints.find(item => item.kind === "public" && item.url === endpoint);
  if (!publicEndpoint || !HEX_32.test(descriptor.gatewayId) || !HEX_32.test(descriptor.publicKey)) return undefined;
  if (hex(sha256(fromHex(descriptor.publicKey))) !== descriptor.gatewayId) return undefined;
  return { descriptor, endpoint: publicEndpoint.url };
}

function validateAuth(profile: GatewayProfile, options?: PeerTransportOptions): { kind: AuthKind; token: string } | undefined {
  const auth = options?.auth ?? { kind: "access" as const, token: profile.accessToken };
  // Peer access signaling accepts durable device grants, not legacy browser sessions.
  if (auth?.kind === "access" && profile.authMode !== "device") return undefined;
  if (!auth || (auth.kind !== "access" && auth.kind !== "pairing") ||
      typeof auth.token !== "string" || auth.token.length < 32 || auth.token.length > 512 ||
      /[\r\n\0]/.test(auth.token)) return undefined;
  return auth;
}

async function createPeerSession(
  profile: GatewayProfile,
  scope: PeerTransportReleaseScope,
  descriptor: GatewayConnectionRoutes,
  endpoint: string,
  auth: { kind: AuthKind; token: string },
  keyId: string,
  family: string,
  signal: AbortSignal,
): Promise<PeerSession | undefined> {
  let connection: PeerConnectionLike | undefined;
  let channel: PeerDataChannel | undefined;
  const deadline = Date.now() + HANDSHAKE_BUDGET_MS;
  const remaining = () => Math.max(1, deadline - Date.now());
  try {
    const stunUrls = await getPeerConfig(endpoint, signal, descriptor.gatewayId);
    if (!stunUrls || signal.aborted || Date.now() >= deadline) return undefined;
    const configuration: PeerIceConfiguration = {
      iceServers: stunUrls.map(url => ({ urls: url })),
      iceTransportPolicy: "all",
    };
    connection = await awaitWithSignal(
      createPlatformPeerConnection(configuration),
      signal,
      lateConnection => { try { lateConnection.close(); } catch { /* Late owned setup resource. */ } },
    );
    channel = connection.createDataChannel(PEER_CHANNEL_LABEL, { ordered: true });
    channel.binaryType = "arraybuffer";
    const offer = await awaitWithSignal(connection.createOffer(), signal);
    throwIfAborted(signal);
    await awaitWithSignal(connection.setLocalDescription(offer), signal);
    if (connection.iceGatheringState !== "complete") {
      await waitForEvent(
        connection,
        "icegatheringstatechange",
        () => connection?.iceGatheringState === "complete",
        signal,
        remaining(),
      );
    }
    throwIfAborted(signal);
    const fullOffer = connection.localDescription?.sdp;
    if (typeof fullOffer !== "string" || fullOffer.length === 0 ||
        encodePeerUtf8(fullOffer).byteLength > 60 * 1024 || Date.now() >= deadline) return undefined;

    const nonce = await randomHex(24);
    const offerHash = hex(sha256(encodePeerUtf8(fullOffer)));
    const proofMessage = peerOfferProofMessage(descriptor.gatewayId, nonce, offerHash);
    const proof = hex(hmac(sha256, encodePeerUtf8(auth.token), encodePeerUtf8(proofMessage)));
    const requestBody = JSON.stringify({
      version: 1,
      nonce,
      offer: fullOffer,
      auth: { kind: auth.kind, keyId, proof },
    });
    let response: Response;
    try {
      response = await awaitWithSignal(fetch(endpoint + "/api/mobile/p2p/offer", {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: requestBody,
        signal,
      }), signal, lateResponse => { void lateResponse.body?.cancel(); });
    } catch {
      return undefined;
    }
    if (!response.ok || Date.now() >= deadline) return undefined;
    const payload = await readBoundedJson(response, SIGNALING_RESPONSE_BYTES, signal);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const answer = payload as Record<string, unknown>;
    if (!exactKeys(answer, ["version", "gatewayId", "nonce", "offerHash", "answer", "signature"]) ||
        answer.version !== 1 || answer.gatewayId !== descriptor.gatewayId ||
        answer.nonce !== nonce || answer.offerHash !== offerHash ||
        typeof answer.answer !== "string" || answer.answer.length === 0 ||
        encodePeerUtf8(answer.answer).byteLength > 64 * 1024 ||
        typeof answer.signature !== "string" || !HEX_64.test(answer.signature)) return undefined;
    const signedMessage = encodePeerUtf8(peerAnswerSignatureMessage(
      descriptor.gatewayId,
      nonce,
      offerHash,
      answer.answer,
    ));
    let signatureValid = false;
    try {
      signatureValid = ed25519.verify(
        fromHex(answer.signature),
        signedMessage,
        fromHex(descriptor.publicKey),
      );
    } catch {
      signatureValid = false;
    }
    if (!signatureValid || Date.now() >= deadline) return undefined;

    await awaitWithSignal(
      setPlatformRemoteDescription(connection, { type: "answer", sdp: answer.answer }),
      signal,
    );
    const candidateTypes = await waitForDirectPeer(connection, channel, signal);
    if (Date.now() >= deadline || signal.aborted ||
        scopeIdentity(profileScope(profile)) !== scopeIdentity(scope) ||
        familyKey(profile, descriptor, endpoint, auth.kind) !== family) return undefined;

    const id = await randomHex(24);
    const opaqueUrl = PEER_URL_PREFIX + id;
    const session = {} as PeerSession;
    Object.assign(session, {
      id,
      url: opaqueUrl,
      familyKey: family,
      scope,
      authKind: auth.kind,
      keyId,
      gatewayId: descriptor.gatewayId,
      publicKey: descriptor.publicKey,
      endpoint,
      createdAt: Date.now(),
      peerConnection: connection,
      dataChannel: channel,
      operations: new Map<string, Operation>(),
      sendQueue: Promise.resolve(),
      dead: false,
      closing: false,
      bytesSent: 0,
      bytesReceived: 0,
      localCandidateType: candidateTypes.local,
      remoteCandidateType: candidateTypes.remote,
      inboundBytes: 0,
      inboundAssemblyCount: 0,
      outboundBytes: 0,
      outboundAssemblyCount: 0,
      pendingResponseBytes: 0,
    });
    attachSessionMethods(session);
    attachSessionEvents(session);
    sessionsByUrl.set(opaqueUrl, session);
    sessionsByFamily.set(family, session);
    connection = undefined;
    channel = undefined;
    return session;
  } catch {
    return undefined;
  } finally {
    if (channel) {
      try { channel.close(); } catch { /* Owned setup resource only. */ }
    }
    if (connection) {
      try { connection.close(); } catch { /* Owned setup resource only. */ }
    }
  }
}

function attachSessionEvents(session: PeerSession): void {
  assignEvent(session.dataChannel, "message", event => {
    const data = event.data;
    if (typeof data !== "string") {
      session.fail(new Error("Unexpected binary Gateway peer frame"));
      return;
    }
    session.bytesReceived += encodePeerUtf8(data).byteLength;
    let frame: GatewayPeerFrame;
    try {
      frame = parsePeerFrame(data);
    } catch {
      session.fail(new Error("Invalid Gateway peer frame"));
      return;
    }
    handleFrame(session, frame);
  });
  assignEvent(session.dataChannel, "close", () => session.fail(new Error("P2P data channel closed")));
  assignEvent(session.dataChannel, "error", () => session.fail(new Error("P2P data channel failed")));
  assignEvent(session.peerConnection, "connectionstatechange", () => {
    const state = session.peerConnection.connectionState;
    if (state === "failed" || state === "closed" || state === "disconnected") {
      session.fail(new Error("P2P peer connection " + state));
    }
  });
  assignEvent(session.peerConnection, "iceconnectionstatechange", () => {
    const state = session.peerConnection.iceConnectionState;
    if (state === "failed" || state === "closed") session.fail(new Error("P2P ICE " + state));
  });
}

function handleFrame(session: PeerSession, frame: GatewayPeerFrame): void {
  if (session.dead) return;
  if (frame.type === "error") {
    if (frame.id === null) {
      session.fail(new Error("Gateway peer session error: " + frame.code));
      return;
    }
    const operation = session.operations.get(frame.id);
    if (!operation) return;
    if (operation.kind === "http") failHttp(session, operation, new Error("Gateway peer HTTP error: " + frame.code));
    else operation.handleRemoteError(frame.code);
    return;
  }
  const operation = session.operations.get(frame.id);
  if (!operation) return;
  if (frame.type === "ws.opened" && operation.kind === "ws") {
    operation.handleOpened(frame.protocol);
    return;
  }
  if (frame.type === "ws.closed" && operation.kind === "ws") {
    operation.handleClosed(frame.code, frame.reason);
    return;
  }
  if (frame.type === "ws.message.start" && operation.kind === "ws") {
    operation.handleMessageStart(frame.messageId, frame.binary, frame.byteLength);
    return;
  }
  if (frame.type === "ws.message.chunk" && operation.kind === "ws") {
    operation.handleMessageChunk(frame.messageId, frame.seq, frame.data);
    return;
  }
  if (frame.type === "ws.message.end" && operation.kind === "ws") {
    operation.handleMessageEnd(frame.messageId);
    return;
  }
  if (operation.kind === "http") {
    handleHttpFrame(session, operation, frame);
    return;
  }
  session.fail(new Error("Unexpected Gateway peer frame for WebSocket operation"));
}

function handleHttpFrame(session: PeerSession, operation: HttpOperation, frame: GatewayPeerFrame): void {
  if (frame.type === "http.response.start") {
    if (operation.responseStarted) {
      session.fail(new Error("Duplicate P2P HTTP response start"));
      return;
    }
    operation.responseStarted = true;
    operation.responseStatus = frame.status;
    operation.responseHeaders = sanitizeResponseHeaders(frame.headers);
    operation.responseExpectedLength = frame.bodyLength;
    const streamAvailable = typeof ReadableStream !== "undefined" &&
      !FORBIDDEN_RESPONSE_BODY_STATUS.has(frame.status);
    if (streamAvailable) {
      const stream = new ReadableStream<Uint8Array>({
        start: controller => { operation.responseController = controller; },
        pull: controller => {
          const chunk = operation.responseChunks.shift();
          if (chunk) {
            operation.receiveBytesPending -= chunk.byteLength;
            session.pendingResponseBytes -= chunk.byteLength;
            controller.enqueue(chunk);
          } else if (!operation.responseEnded) {
            operation.responsePullPending = true;
          }
          if (operation.responseEnded && operation.responseChunks.length === 0) {
            try { controller.close(); } catch { /* Consumer already closed. */ }
            finishStreamResponse(session, operation);
          }
        },
        cancel: () => cancelHttp(session, operation),
      }, { highWaterMark: 0, size: chunk => chunk.byteLength });
      try {
        operation.resolveResponse(new Response(stream, {
          status: frame.status,
          headers: operation.responseHeaders as HeadersInit,
        }));
      } catch {
        session.fail(new Error("P2P streaming Response is unavailable"));
      }
    } else if (frame.bodyLength === 0 || frame.bodyLength === null ||
        FORBIDDEN_RESPONSE_BODY_STATUS.has(frame.status)) {
      // The response object is completed after the end frame for non-streaming runtimes.
    }
    return;
  }
  if (frame.type === "http.response.chunk") {
    if (!operation.responseStarted || operation.responseEnded || frame.seq !== operation.responseSequence) {
      session.fail(new Error("Invalid P2P HTTP response sequence"));
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = decodePeerBase64(frame.data);
      if (bytes.byteLength === 0 || decodedPeerChunkBytes(frame.data) !== bytes.byteLength) throw new Error("Invalid base64 chunk");
    } catch {
      session.fail(new Error("Invalid P2P HTTP response chunk"));
      return;
    }
    operation.responseSequence += 1;
    operation.responseReceived += bytes.byteLength;
    const deliverToPendingReader = Boolean(operation.responseController && operation.responsePullPending);
    if (operation.responseReceived > PEER_MESSAGE_BYTES ||
        (operation.responseExpectedLength !== null &&
          operation.responseReceived > operation.responseExpectedLength) ||
        session.pendingResponseBytes + (deliverToPendingReader ? 0 : bytes.byteLength) >
          MAX_BUFFERED_RECEIVE_BYTES) {
      session.fail(new Error("P2P HTTP receive buffer exceeded"));
      return;
    }
    if (deliverToPendingReader && operation.responseController) {
      operation.responsePullPending = false;
      operation.responseController.enqueue(bytes);
    } else {
      operation.receiveBytesPending += bytes.byteLength;
      session.pendingResponseBytes += bytes.byteLength;
      operation.responseChunks.push(bytes);
    }
    return;
  }
  if (frame.type === "http.response.end") {
    if (!operation.responseStarted || operation.responseEnded ||
        (operation.responseExpectedLength !== null &&
          operation.responseReceived !== operation.responseExpectedLength)) {
      session.fail(new Error("Incomplete P2P HTTP response"));
      return;
    }
    operation.responseEnded = true;
    clearTimeout(operation.timer);
    if (operation.responseController) {
      if (operation.responseChunks.length === 0) {
        try { operation.responseController.close(); } catch { /* Consumer already cancelled. */ }
        finishStreamResponse(session, operation);
      }
    } else if (!operation.responseStarted || !operation.responseChunks) {
      operation.rejectResponse(new Error("Missing P2P HTTP response"));
    } else {
      const bodyBytes = operation.responseChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      session.pendingResponseBytes = Math.max(0, session.pendingResponseBytes - bodyBytes);
      operation.receiveBytesPending = 0;
      operation.resolveResponse(new Response(
        FORBIDDEN_RESPONSE_BODY_STATUS.has(operation.responseStatus ?? 200) ||
          operation.responseChunks.length === 0
          ? null
          : peerBytesToArrayBuffer(joinBytes(
            operation.responseChunks,
            operation.responseChunks.reduce((total, chunk) => total + chunk.byteLength, 0),
          )),
        {
          status: operation.responseStatus,
          headers: operation.responseHeaders as HeadersInit,
        },
      ));
      finishStreamResponse(session, operation);
    }
    return;
  }
  session.fail(new Error("Unexpected Gateway peer HTTP frame"));
}

function sanitizeResponseHeaders(headers: GatewayPeerHttpHeaders): GatewayPeerHttpHeaders {
  const result: GatewayPeerHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (RESPONSE_HEADERS.has(name) && typeof value === "string") {
      (result as Record<string, string>)[name] = value;
    }
  }
  return result;
}

function failHttp(session: PeerSession, operation: HttpOperation, error: Error): void {
  clearTimeout(operation.timer);
  operation.abortCleanup?.();
  session.operations.delete(operation.id);
  releaseHttpPendingBytes(session, operation);
  try { operation.responseController?.error(error); } catch { /* Stream already consumed or cancelled. */ }
  operation.rejectResponse(error);
}

function cancelHttp(session: PeerSession, operation: HttpOperation): void {
  const active = session.operations.get(operation.id) === operation;
  if (!session.dead && active && !operation.responseEnded) {
    void session.sendFrame({
      version: PEER_TRANSPORT_VERSION,
      type: "http.cancel",
      id: operation.id,
    }).catch(() => {});
  }
  clearTimeout(operation.timer);
  operation.abortCleanup?.();
  session.operations.delete(operation.id);
  releaseHttpPendingBytes(session, operation);
}

function releaseHttpPendingBytes(session: PeerSession, operation: HttpOperation): void {
  const queued = operation.responseChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  session.pendingResponseBytes = Math.max(0, session.pendingResponseBytes - queued);
  operation.receiveBytesPending = 0;
  operation.responseChunks = [];
}

function finishStreamResponse(session: PeerSession, operation: HttpOperation): void {
  if (!operation.responseEnded || operation.responseChunks.length > 0) return;
  clearTimeout(operation.timer);
  operation.abortCleanup?.();
  if (session.operations.get(operation.id) === operation) session.operations.delete(operation.id);
}

function attachSessionMapCleanup(session: PeerSession): void {
  if (sessionsByUrl.get(session.url) === session) sessionsByUrl.delete(session.url);
  if (sessionsByFamily.get(session.familyKey) === session) sessionsByFamily.delete(session.familyKey);
}

function makeSessionDead(session: PeerSession, error: Error): void {
  if (session.dead) return;
  session.dead = true;
  attachSessionMapCleanup(session);
  for (const operation of Array.from(session.operations.values())) {
    if (operation.kind === "http") failHttp(session, operation, error);
    else operation.fail(error);
  }
  session.operations.clear();
  closeOwnedPeer(session);
}

function closeOwnedPeer(session: PeerSession): void {
  if (session.closing) return;
  session.closing = true;
  try { session.dataChannel.close(); } catch { /* Owned channel cleanup. */ }
  try { session.peerConnection.close(); } catch { /* Owned peer cleanup. */ }
}

function attachSessionMethods(session: PeerSession): void {
  session.fail = (error: Error) => makeSessionDead(session, error);
  session.sendFrame = (frame: GatewayPeerFrame, canSend?: () => boolean): Promise<void> => {
      if (session.dead || session.dataChannel.readyState !== "open") {
        return Promise.reject(new Error("P2P transport is closed"));
      }
      const raw = encodePeerFrame(frame);
      const bytes = encodePeerUtf8(raw).byteLength;
      const send = async () => {
        if (canSend && !canSend()) throw abortError();
        await waitForBufferDrain(session.dataChannel, bytes);
        if (canSend && !canSend()) throw abortError();
        if (session.dead || session.dataChannel.readyState !== "open") throw new Error("P2P transport is closed");
        session.dataChannel.send(raw);
        session.bytesSent += bytes;
      };
      const queued = session.sendQueue.then(send, send);
      session.sendQueue = queued.catch(error => {
        if (!(canSend && !canSend()) && (error as Error)?.name !== "AbortError") {
          session.fail(error instanceof Error ? error : new Error("P2P data channel send failed"));
        }
        throw error;
      });
      return session.sendQueue;
  };
}

function waitForBufferDrain(channel: PeerDataChannel, nextMessageBytes: number): Promise<void> {
  const lowWatermark = Math.max(0, PEER_BUFFER_HIGH_WATERMARK - nextMessageBytes);
  if (channel.bufferedAmount <= lowWatermark) return Promise.resolve();
  if (channel.bufferedAmountLowThreshold !== undefined) {
    channel.bufferedAmountLowThreshold = Math.floor(PEER_BUFFER_HIGH_WATERMARK / 2);
  }
  return new Promise<void>((resolve, reject) => {
    let finished = false;
    const timeout = setTimeout(() => finish(new Error("P2P data channel backpressure timed out")), DRAIN_TIMEOUT_MS);
    const poll = setInterval(() => {
      if (channel.bufferedAmount <= lowWatermark) finish();
    }, 25);
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearInterval(poll);
      channel.removeEventListener?.("bufferedamountlow", onLow);
      channel.removeEventListener?.("close", onClosed);
      if (error) reject(error);
      else resolve();
    };
    const onLow = () => {
      if (channel.bufferedAmount <= lowWatermark) finish();
    };
    const onClosed = () => finish(new Error("P2P data channel closed during backpressure"));
    channel.addEventListener?.("bufferedamountlow", onLow);
    channel.addEventListener?.("close", onClosed);
    if (channel.bufferedAmount <= lowWatermark) finish();
  });
}

async function awaitFlight(flight: SessionFlight, signal?: AbortSignal): Promise<PeerSession | undefined> {
  throwIfAborted(signal);
  flight.waiters += 1;
  return new Promise<PeerSession | undefined>((resolve, reject) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.controller.signal.aborted) flight.controller.abort();
    };
    const onAbort = () => {
      finish();
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    flight.promise.then(
      session => {
        finish();
        resolve(session);
      },
      error => {
        finish();
        reject(error);
      },
    );
  });
}

export async function tryCreatePeerTransport(
  profile: GatewayProfile,
  descriptorValue: unknown,
  publicUrl: string,
  options: PeerTransportOptions = {},
): Promise<string | undefined> {
  throwIfAborted(options.signal);
  const verified = validateDescriptor(descriptorValue, publicUrl);
  const auth = validateAuth(profile, options);
  if (!verified || !auth) return undefined;
  const { descriptor, endpoint } = verified;
  const keyId = hex(sha256(encodePeerUtf8(auth.token)));
  const scope = profileScope(profile);
  const family = familyKey(profile, descriptor, endpoint, auth.kind);
  const alive = sessionsByFamily.get(family);
  if (alive && !alive.dead && alive.dataChannel.readyState === "open") return alive.url;
  if (alive) makeSessionDead(alive, new Error("Stale P2P session replaced"));

  const flightKey = JSON.stringify([family, keyId]);
  let flight = sessionFlights.get(flightKey);
  if (!flight) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HANDSHAKE_BUDGET_MS);
    const promise = createPeerSession(profile, scope, descriptor, endpoint, auth, keyId, family, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timeout);
        if (sessionFlights.get(flightKey) === flight) sessionFlights.delete(flightKey);
      });
    flight = {
      controller,
      promise,
      waiters: 0,
      scope,
      familyKey: family,
    };
    sessionFlights.set(flightKey, flight);
  }
  const session = await awaitFlight(flight, options.signal);
  if (scopeIdentity(profileScope(profile)) !== scopeIdentity(scope) ||
      familyKey(profile, descriptor, endpoint, auth.kind) !== family) {
    return undefined;
  }
  return session && !session.dead ? session.url : undefined;
}

export function isPeerTransportUrl(value: string): boolean {
  return typeof value === "string" && /^kcoder-p2p:\/\/[a-f0-9]{48}$/.test(value);
}

function routeForInput(input: RequestInfo | URL): { session: PeerSession; path: string } {
  const raw = typeof input === "string"
    ? input
    : typeof URL !== "undefined" && input instanceof URL
      ? input.toString()
      : (input as Request).url;
  const match = /^kcoder-p2p:\/\/([a-f0-9]{48})(\/[^#]*)?$/.exec(raw);
  if (!match) throw new TypeError("Invalid Mobile P2P route");
  const url = PEER_URL_PREFIX + match[1];
  const session = sessionsByUrl.get(url);
  if (!session || session.dead) throw new Error("Mobile P2P session is unavailable");
  const path = match[2] ?? "/";
  if (!path.startsWith("/api/") && path.split("?", 1)[0] !== "/rpc") {
    throw new TypeError("Mobile P2P path is not allowed");
  }
  return { session, path };
}

function normalizeHeaders(input: HeadersInit | undefined, request: Request | undefined): GatewayPeerHttpHeaders {
  const output: GatewayPeerHttpHeaders = {};
  const headers = new Headers(input ?? request?.headers);
  headers.forEach((value, name) => {
    const normalizedName = name.toLowerCase();
    if (!HTTP_REQUEST_HEADERS.has(normalizedName)) {
      throw new TypeError("Header is not allowed over Mobile P2P: " + normalizedName);
    }
    (output as Record<string, string>)[normalizedName] = value;
  });
  return output;
}

async function readRequestBody(
  init: RequestInit,
  request: Request | undefined,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const body = init.body !== undefined ? init.body : request?.body;
  if (body === undefined || body === null) return new Uint8Array();
  if (typeof body === "string") return encodePeerUtf8(body);
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return copyPeerBytes(body as ArrayBuffer | ArrayBufferView);
  if (typeof Blob !== "undefined" && body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        throwIfAborted(signal);
        const result = signal ? await awaitWithSignal(reader.read(), signal) : await reader.read();
        if (result.done) break;
        const chunk = typeof result.value === "string"
          ? encodePeerUtf8(result.value)
          : copyPeerBytes(result.value as ArrayBuffer | ArrayBufferView);
        length += chunk.byteLength;
        if (length > PEER_MESSAGE_BYTES) throw new RangeError("P2P request body exceeds 16 MiB");
        chunks.push(chunk);
      }
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    return joinBytes(chunks, length);
  }
  throw new TypeError("Unsupported Mobile P2P request body");
}

export async function peerFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const { session, path } = routeForInput(input);
  if (session.operations.size >= PEER_MAX_OPERATIONS) throw new Error("Mobile P2P operation limit reached");
  const request = typeof Request !== "undefined" && input instanceof Request ? input : undefined;
  const method = (init.method ?? request?.method ?? "GET").toUpperCase() as "GET" | "POST" | "PUT" | "DELETE";
  if (!["GET", "POST", "PUT", "DELETE"].includes(method)) throw new TypeError("Unsupported Mobile P2P HTTP method");
  const headers = normalizeHeaders(init.headers, request);
  const signal = init.signal ?? request?.signal;
  throwIfAborted(signal);
  const body = await readRequestBody(init, request, signal);
  if (body.byteLength > PEER_MESSAGE_BYTES) throw new RangeError("P2P request body exceeds 16 MiB");
  if (session.dead) throw new Error("Mobile P2P session is unavailable");
  if (session.operations.size >= PEER_MAX_OPERATIONS) throw new Error("Mobile P2P operation limit reached");

  const id = await randomHex(18);
  return new Promise<Response>((resolve, reject) => {
    let resolveOnce = false;
    let rejectOnce = false;
    let operation!: HttpOperation;
    operation = {
      kind: "http",
      id,
      responseExpectedLength: null,
      responseReceived: 0,
      responseSequence: 0,
      responseChunks: [],
      responsePullPending: false,
      resolveResponse: response => {
        if (resolveOnce) return;
        resolveOnce = true;
        resolve(response);
      },
      rejectResponse: error => {
        if (rejectOnce || resolveOnce) return;
        rejectOnce = true;
        reject(error);
      },
      responseStarted: false,
      responseEnded: false,
      receiveBytesPending: 0,
        timer: setTimeout(() => {
          cancelHttp(session, operation);
          try { operation.responseController?.error(new Error("Mobile P2P HTTP request timed out")); } catch { /* Response already closed. */ }
          operation.rejectResponse(new Error("Mobile P2P HTTP request timed out"));
        }, OPERATION_TIMEOUT_MS),
    };
    session.operations.set(id, operation);
    const onAbort = () => {
      cancelHttp(session, operation);
      try { operation.responseController?.error(abortError()); } catch { /* Response may already be consumed. */ }
      operation.rejectResponse(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    operation.abortCleanup = () => signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    const startFrame = {
      version: PEER_TRANSPORT_VERSION,
      type: "http.request.start",
      id,
      method,
      path,
      headers,
      bodyLength: body.byteLength,
    } as const;
    void (async () => {
      try {
        if (signal?.aborted || !session.operations.has(id)) throw abortError();
        const stillOwned = () => !signal?.aborted && session.operations.get(id) === operation;
        await session.sendFrame(startFrame, stillOwned);
        for (let offset = 0, sequence = 0; offset < body.byteLength; offset += PEER_CHUNK_BYTES, sequence += 1) {
          if (!stillOwned()) throw abortError();
          await session.sendFrame({
            version: PEER_TRANSPORT_VERSION,
            type: "http.request.chunk",
            id,
            seq: sequence,
            data: encodePeerBase64(body.subarray(offset, Math.min(offset + PEER_CHUNK_BYTES, body.byteLength))),
          }, stillOwned);
        }
        if (!stillOwned()) throw abortError();
        await session.sendFrame({ version: PEER_TRANSPORT_VERSION, type: "http.request.end", id }, stillOwned);
      } catch (error) {
        if (session.operations.has(id)) {
          failHttp(session, operation, error instanceof Error ? error : new Error("Mobile P2P request failed"));
        }
      }
    })();
  });
}

function normalizeProtocolList(protocols?: string | string[]): string[] {
  if (protocols === undefined) return [];
  const result = typeof protocols === "string" ? [protocols] : protocols.slice();
  if (result.length > 2 || result.some(protocol => typeof protocol !== "string" || protocol.length === 0) ||
      new Set(result).size !== result.length) throw new TypeError("Invalid Mobile P2P WebSocket protocols");
  return result;
}

function peerPathFromSocketUrl(value: string): { session: PeerSession; path: string } {
  const route = routeForInput(value);
  if (route.path.split("?", 1)[0] !== "/rpc") throw new TypeError("Mobile P2P WebSocket only supports /rpc");
  return route;
}

function validCloseCode(value: number): boolean {
  return Number.isInteger(value) && value >= 1000 && value <= 4999 &&
    value !== 1004 && value !== 1005 && value !== 1006 && value !== 1015;
}

export function createPeerSocket(
  url: string,
  protocols?: string | string[],
  headers?: Record<string, string>,
): PeerWebSocket {
  const { session, path } = peerPathFromSocketUrl(url);
  if (session.operations.size >= PEER_MAX_OPERATIONS) throw new Error("Mobile P2P operation limit reached");
  const selectedProtocols = normalizeProtocolList(protocols);
  let authorization: string | null = null;
  if (headers) {
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() !== "authorization" || typeof value !== "string") {
        throw new TypeError("Only Authorization is allowed for Mobile P2P WebSocket");
      }
      authorization = value;
    }
  }
  peerSocketSequence += 1;
  const id = "s" + Date.now().toString(36) + "_" + peerSocketSequence.toString(36);
  return new PeerWebSocket(session, id, url, selectedProtocols, authorization, path);
}

export function invalidatePeerTransport(url: string): void {
  if (!isPeerTransportUrl(url)) return;
  const session = sessionsByUrl.get(url);
  if (session) makeSessionDead(session, new Error("Mobile P2P transport invalidated"));
}

export function isPeerTransportAlive(url: string): boolean {
  if (!isPeerTransportUrl(url)) return false;
  const session = sessionsByUrl.get(url);
  return Boolean(session && !session.dead && session.dataChannel.readyState === "open" &&
    (session.peerConnection.connectionState === undefined ||
      session.peerConnection.connectionState === "connected"));
}

export function releasePeerTransports(value: GatewayProfile | PeerTransportReleaseScope): void {
  const scope = normalizedReleaseScope(value);
  if (!scope) return;
  for (const session of sessionsByUrl.values()) {
    if (sameReleaseOwner(session, scope)) makeSessionDead(session, new Error("Mobile P2P profile scope released"));
  }
  for (const flight of sessionFlights.values()) {
    const flightScope = flight.scope;
    if (flightScope.profileId === scope.profileId &&
        flightScope.baseUrl === scope.baseUrl &&
        (scope.deviceId === undefined || flightScope.deviceId === scope.deviceId) &&
        (scope.authorizationGeneration === undefined ||
          flightScope.authorizationGeneration === scope.authorizationGeneration) &&
        (scope.authMode === undefined || flightScope.authMode === scope.authMode)) {
      flight.controller.abort();
    }
  }
}

export async function getPeerTransportDiagnostics(url: string): Promise<PeerTransportDiagnostics | undefined> {
  if (!isPeerTransportUrl(url)) return undefined;
  const session = sessionsByUrl.get(url);
  if (!session) return undefined;
  try {
    const candidateTypes = candidateTypesFromStats(await session.peerConnection.getStats());
    if (candidateTypes.local) session.localCandidateType = candidateTypes.local;
    if (candidateTypes.remote) session.remoteCandidateType = candidateTypes.remote;
  } catch {
    // Diagnostics are best-effort and never affect transport health.
  }
  return {
    state: session.dead ? "closed" : "open",
    peerConnectionState: session.peerConnection.connectionState ?? "unknown",
    dataChannelState: session.dataChannel.readyState,
    ...(session.localCandidateType ? { localCandidateType: session.localCandidateType } : {}),
    ...(session.remoteCandidateType ? { remoteCandidateType: session.remoteCandidateType } : {}),
    bytesSent: session.bytesSent,
    bytesReceived: session.bytesReceived,
    activeOperations: session.operations.size,
    platform: PEER_PLATFORM_NATIVE ? "native" : "web",
  };
}

function joinBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
