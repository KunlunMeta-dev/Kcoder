import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import withWebRtcDataChannelOnlyPermissions from "./withWebRtcDataChannelOnlyPermissions.js";

const appJson = JSON.parse(await readFile(new URL("../../app.json", import.meta.url), "utf8"));

test("keeps camera scanning but removes the generated iOS microphone usage string", async () => {
  const config = withWebRtcDataChannelOnlyPermissions({ ios: {}, mods: {} });
  const result = await config.mods.ios.infoPlist({
    modResults: {
      NSCameraUsageDescription: "Use the camera to scan a Gateway pairing code.",
      NSMicrophoneUsageDescription: "Allow access to the microphone.",
    },
  });

  assert.equal(result.ios.infoPlist.NSCameraUsageDescription, "Use the camera to scan a Gateway pairing code.");
  assert.equal("NSMicrophoneUsageDescription" in result.ios.infoPlist, false);
});

test("blocks WebRTC audio permissions in the Android manifest merger", () => {
  const blocked = new Set(appJson.expo.android.blockedPermissions);
  for (const permission of [
    "android.permission.RECORD_AUDIO",
    "android.permission.MODIFY_AUDIO_SETTINGS",
    "android.permission.BLUETOOTH",
  ]) assert.ok(blocked.has(permission), `Android permission remains blocked: ${permission}`);
});
