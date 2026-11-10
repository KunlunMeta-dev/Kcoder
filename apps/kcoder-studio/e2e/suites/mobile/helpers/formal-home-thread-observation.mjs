import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const fingerprint = value => typeof value === "string"
  ? createHash("sha256").update(value).digest("hex").slice(0, 16)
  : null;
const fingerprintJson = value => {
  const serialized = JSON.stringify(value);
  return typeof serialized === "string"
    ? createHash("sha256").update(serialized).digest("hex").slice(0, 16)
    : null;
};

export function captureThreadListFixtureFields(thread) {
  return {
    threadIdFingerprint: fingerprint(thread?.id),
    titleFingerprint: fingerprint(thread?.title),
    status: typeof thread?.status === "string" ? thread.status : null,
    cwdFingerprint: fingerprint(thread?.cwd),
    updatedAt: Number.isFinite(thread?.updatedAt) ? thread.updatedAt : null,
    recordFingerprint: fingerprintJson(thread),
    previewFingerprint: fingerprint(thread?.preview),
    summaryFingerprint: fingerprint(thread?.summary),
  };
}

export function assertFormalHomeThreadPresentationStable(before, after, phase) {
  assert.equal(after.serverIdFingerprint, before.serverIdFingerprint, `the Home server scope must remain unchanged ${phase}`);
  assert.equal(after.rowTextFingerprint, before.rowTextFingerprint, `the full Home row text must remain unchanged ${phase}`);
  assert.equal(after.titleFingerprint, before.titleFingerprint, `the Home title must remain unchanged ${phase}`);
  assert.equal(after.relativeTimeText, before.relativeTimeText, `the raw Home relative-time label must remain unchanged ${phase}`);
  assert.deepEqual(after.statusTextFingerprints, before.statusTextFingerprints, `the Home status text must remain unchanged ${phase}`);
  assert.equal(after.workspaceHeaderFingerprint, before.workspaceHeaderFingerprint, `the Home workspace header must remain unchanged ${phase}`);
  assert.deepEqual(after.fixtureFields, before.fixtureFields, `the exact thread/list row fields must remain unchanged ${phase}`);
  return { stable: true, relativeTimeText: after.relativeTimeText, fixtureFieldsStable: true, fullRowTextStable: true };
}

export function safeAuthCleanupErrorField(value) {
  if (typeof value === "string" && /^[A-Za-z0-9_:-]{1,64}$/.test(value)) return value;
  if (Number.isSafeInteger(value)) return value;
  return null;
}
