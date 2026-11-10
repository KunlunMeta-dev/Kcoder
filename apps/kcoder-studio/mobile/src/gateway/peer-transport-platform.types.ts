export interface PeerIceServer {
  urls: string | string[];
}

export interface PeerIceConfiguration {
  iceServers: PeerIceServer[];
  iceTransportPolicy: "all";
}

export interface PeerEvent {
  data?: unknown;
  candidate?: unknown;
  target?: unknown;
}

export interface PeerEventTarget {
  addEventListener?(type: string, listener: (event: PeerEvent) => void): void;
  removeEventListener?(type: string, listener: (event: PeerEvent) => void): void;
}

export interface PeerDataChannel extends PeerEventTarget {
  label: string;
  readyState: string;
  bufferedAmount: number;
  bufferedAmountLowThreshold?: number;
  binaryType?: string;
  send(data: string): void;
  close(): void;
}

export interface PeerSessionDescription {
  type: string;
  sdp?: string;
}

export interface PeerConnectionLike extends PeerEventTarget {
  connectionState?: string;
  iceConnectionState?: string;
  iceGatheringState: string;
  localDescription?: PeerSessionDescription | null;
  createDataChannel(label: string, options: { ordered: true }): PeerDataChannel;
  createOffer(): Promise<PeerSessionDescription>;
  setLocalDescription(description: PeerSessionDescription): Promise<void>;
  setRemoteDescription(description: PeerSessionDescription): Promise<void>;
  getStats(): Promise<unknown>;
  close(): void;
}
