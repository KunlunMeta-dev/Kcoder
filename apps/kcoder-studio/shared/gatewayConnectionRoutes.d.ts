export type GatewayConnectionEndpoint = {
  kind: 'public';
  /** Canonical HTTP(S) origin or Relay mount URL, without a trailing slash. */
  url: string;
};

export type GatewayConnectionRoutes = {
  version: 1;
  /** Lowercase SHA-256 hex of the raw Ed25519 public key. */
  gatewayId: string;
  /** Raw 32-byte Ed25519 public key, lowercase hex. */
  publicKey: string;
  endpoints: GatewayConnectionEndpoint[];
};

export function canonicalGatewayConnectionUrl(value: unknown): string | undefined;
export function isLoopbackGatewayConnectionUrl(value: unknown): boolean;
export function parseGatewayConnectionRoutes(value: unknown): GatewayConnectionRoutes | undefined;
export function connectionProofMessage(gatewayId: string, nonce: string, endpoint: string): string;
export function parseGatewayConnectionProofQuery(rawQuery: string): { nonce: string; endpoint: string } | undefined;
