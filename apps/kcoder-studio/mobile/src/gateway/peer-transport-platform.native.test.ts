import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeModule = vi.hoisted(() => ({
  loadCount: 0,
  configuration: undefined as unknown,
  remote: undefined as unknown,
}));

vi.mock("react-native-webrtc", () => {
  nativeModule.loadCount += 1;
  return {
    RTCPeerConnection: class {
      constructor(configuration: unknown) {
        nativeModule.configuration = configuration;
      }
      setRemoteDescription(description: unknown) {
        nativeModule.remote = description;
        return Promise.resolve();
      }
    },
    RTCSessionDescription: class {
      constructor(_description: unknown) {}
    },
  };
});

import {
  createPlatformPeerConnection,
  PEER_PLATFORM_NATIVE,
  setPlatformRemoteDescription,
} from "./peer-transport-platform.native";

describe("native peer transport adapter", () => {
  beforeEach(() => {
    nativeModule.loadCount = 0;
    nativeModule.configuration = undefined;
    nativeModule.remote = undefined;
  });

  it("imports without eagerly loading react-native-webrtc", async () => {
    expect(PEER_PLATFORM_NATIVE).toBe(true);
    expect(nativeModule.loadCount).toBe(0);
    expect(createPlatformPeerConnection).toBeTypeOf("function");
    expect(setPlatformRemoteDescription).toBeTypeOf("function");
  });
});
