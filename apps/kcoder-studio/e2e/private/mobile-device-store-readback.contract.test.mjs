import test from "node:test";
import assert from "node:assert/strict";
import { findPersistedMobileDeviceById } from "./mobile-device-store-readback.private.mjs";

test("readback matches the persisted Gateway id field for the exact paired device", () => {
  const owned = { id: "owned-device-id", revoked: true };
  assert.strictEqual(findPersistedMobileDeviceById([owned], "owned-device-id"), owned);
});

test("readback does not select a foreign persisted id", () => {
  const foreign = { id: "foreign-device-id", revoked: true };
  assert.equal(findPersistedMobileDeviceById([foreign], "owned-device-id"), null);
});

test("readback rejects response-shaped deviceId rows as a storage schema", () => {
  const responseProjectionOnly = { deviceId: "owned-device-id", revoked: true };
  assert.equal(findPersistedMobileDeviceById([responseProjectionOnly], "owned-device-id"), null);
});
