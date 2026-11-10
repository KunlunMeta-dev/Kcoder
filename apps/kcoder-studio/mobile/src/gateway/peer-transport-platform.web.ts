import type {
  PeerConnectionLike,
  PeerIceConfiguration,
  PeerSessionDescription,
} from "./peer-transport-platform.types";

export const PEER_PLATFORM_NATIVE = false;

export async function createPlatformPeerConnection(
  configuration: PeerIceConfiguration,
): Promise<PeerConnectionLike> {
  const Constructor = globalThis.RTCPeerConnection;
  if (typeof Constructor !== "function") throw new Error("WebRTC is not available in this browser");
  return new Constructor(configuration as RTCConfiguration) as unknown as PeerConnectionLike;
}

export async function setPlatformRemoteDescription(
  connection: PeerConnectionLike,
  description: PeerSessionDescription,
): Promise<void> {
  await connection.setRemoteDescription(description);
}
