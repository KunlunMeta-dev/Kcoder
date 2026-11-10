export declare const PEER_TRANSPORT_VERSION: 1;
export declare const PEER_FRAME_BYTES: 16384;
export declare const PEER_CHUNK_BYTES: 8192;
export declare const PEER_MESSAGE_BYTES: 16777216;
export declare const PEER_MAX_OPERATIONS: 8;
export declare const PEER_BUFFER_HIGH_WATERMARK: 1048576;
export declare const PEER_CHANNEL_LABEL: 'kcoder-gateway-v1';
export declare const PEER_OFFER_PROOF_DOMAIN: 'kcoder.gateway.peer-offer.v1';
export declare const PEER_ANSWER_SIGNATURE_DOMAIN: 'kcoder.gateway.peer-answer.v1';

export type GatewayPeerOfferProof = { kind: 'pairing' | 'access'; keyId: string; proof: string };
export type GatewayPeerOfferRequest = { version: 1; nonce: string; offer: string; auth: GatewayPeerOfferProof };
export type GatewayPeerOfferResponse = { version: 1; gatewayId: string; nonce: string; offerHash: string; answer: string; signature: string };
export type GatewayPeerConfig = { version: 1; gatewayId: string; stunUrls: string[] };

export type GatewayPeerHttpHeaders = Partial<Record<'authorization' | 'content-type' | 'accept' | 'if-match' | 'if-none-match' | 'range' | 'content-range', string>>;
export type GatewayPeerHttpRequestStart = { version: 1; type: 'http.request.start'; id: string; method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; headers: GatewayPeerHttpHeaders; bodyLength: number | null };
export type GatewayPeerHttpRequestChunk = { version: 1; type: 'http.request.chunk'; id: string; seq: number; data: string };
export type GatewayPeerHttpRequestEnd = { version: 1; type: 'http.request.end'; id: string };
export type GatewayPeerHttpCancel = { version: 1; type: 'http.cancel'; id: string };
export type GatewayPeerHttpResponseStart = { version: 1; type: 'http.response.start'; id: string; status: number; headers: GatewayPeerHttpHeaders; bodyLength: number | null };
export type GatewayPeerHttpResponseChunk = { version: 1; type: 'http.response.chunk'; id: string; seq: number; data: string };
export type GatewayPeerHttpResponseEnd = { version: 1; type: 'http.response.end'; id: string };
export type GatewayPeerWebSocketOpen = { version: 1; type: 'ws.open'; id: string; path: string; authorization: string | null; protocols: string[] };
export type GatewayPeerWebSocketOpened = { version: 1; type: 'ws.opened'; id: string; protocol: string | null };
export type GatewayPeerWebSocketMessageStart = { version: 1; type: 'ws.message.start'; id: string; messageId: string; binary: boolean; byteLength: number };
export type GatewayPeerWebSocketMessageChunk = { version: 1; type: 'ws.message.chunk'; id: string; messageId: string; seq: number; data: string };
export type GatewayPeerWebSocketMessageEnd = { version: 1; type: 'ws.message.end'; id: string; messageId: string };
export type GatewayPeerWebSocketClose = { version: 1; type: 'ws.close' | 'ws.closed'; id: string; code: number; reason: string };
export type GatewayPeerError = { version: 1; type: 'error'; id: string | null; code: string };
export type GatewayPeerFrame = GatewayPeerHttpRequestStart | GatewayPeerHttpRequestChunk | GatewayPeerHttpRequestEnd | GatewayPeerHttpCancel | GatewayPeerHttpResponseStart | GatewayPeerHttpResponseChunk | GatewayPeerHttpResponseEnd | GatewayPeerWebSocketOpen | GatewayPeerWebSocketOpened | GatewayPeerWebSocketMessageStart | GatewayPeerWebSocketMessageChunk | GatewayPeerWebSocketMessageEnd | GatewayPeerWebSocketClose | GatewayPeerError;

export declare function peerUtf8Length(value: string): number;
export declare function peerOfferProofMessage(gatewayId: string, nonce: string, offerHash: string): string;
export declare function peerAnswerSignatureMessage(gatewayId: string, nonce: string, offerHash: string, answer: string): string;
export declare function isPeerFrame(value: unknown): value is GatewayPeerFrame;
export declare function encodePeerFrame(value: GatewayPeerFrame): string;
export declare function parsePeerFrame(raw: string): GatewayPeerFrame;
export declare function decodedPeerChunkBytes(value: string): number;
