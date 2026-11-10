import type {
  PeerConnectionLike,
  PeerIceConfiguration,
  PeerSessionDescription,
} from "./peer-transport-platform.types";

export const PEER_PLATFORM_NATIVE = true;

interface NativeWebRtcModule {
  RTCPeerConnection: new (configuration: PeerIceConfiguration) => PeerConnectionLike;
  RTCSessionDescription?: new (description: PeerSessionDescription) => PeerSessionDescription;
}

let modulePromise: Promise<NativeWebRtcModule> | undefined;

async function loadNativeWebRtc(): Promise<NativeWebRtcModule> {
  if (!modulePromise) {
    // Keep the native package out of the Web graph and load its native bridge only on demand.
    modulePromise = Promise.resolve().then(() => require("react-native-webrtc") as NativeWebRtcModule);
  }
  return modulePromise;
}

export async function createPlatformPeerConnection(
  configuration: PeerIceConfiguration,
): Promise<PeerConnectionLike> {
  const { RTCPeerConnection } = await loadNativeWebRtc();
  return new RTCPeerConnection(configuration);
}

export async function setPlatformRemoteDescription(
  connection: PeerConnectionLike,
  description: PeerSessionDescription,
): Promise<void> {
  const { RTCSessionDescription } = await loadNativeWebRtc();
  await connection.setRemoteDescription(RTCSessionDescription ? new RTCSessionDescription(description) : description);
}
