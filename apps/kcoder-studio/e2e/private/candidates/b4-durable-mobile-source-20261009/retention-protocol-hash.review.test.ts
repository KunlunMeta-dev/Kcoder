import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/retention-upload-v1-contract.json";
import {
  parseRetentionAdmission,
  parseRetentionUploadResult,
  validateRetentionUploadParams,
  RETENTION_CHUNK_BYTES,
  type RetentionUploadParamsV1,
} from "@/protocol/attachment-retention";
import { hashBoundedSource, Sha256Stream } from "@/protocol/sha256-stream";

const admission = parseRetentionAdmission(fixture.admission);
const expected = {
  ownerRequest: fixture.ownerRequest,
  clientUploadId: fixture.clientUploadId,
  admission,
  filename: fixture.source.label,
  size: fixture.source.size,
  contentSha256: fixture.source.sha256,
  scopeId: fixture.scopeId,
  stageRef: fixture.responses.sealed.lookup.recovery.stageRef,
};

describe("B4 candidate static02 typed contract and bounded hash", () => {
  it("parses the authored Rust-shaped sealed receipt and rejects caller-trusted fields", () => {
    const parsed = parseRetentionUploadResult(fixture.responses.sealed, expected);
    expect(parsed.lookup).toMatchObject({ outcome: "present", recovery: { state: "sealed", confirmedBytes: 5 } });
    expect(() => parseRetentionAdmission({ ...fixture.admission, trustedContext: { deviceId: "foreign" } })).toThrow();
    const wrongStage = structuredClone(fixture.responses.sealed);
    wrongStage.lookup.recovery.stageRef.epoch += 1;
    expect(() => parseRetentionUploadResult(wrongStage, expected)).toThrow();
    const wrongScope = structuredClone(fixture.responses.sealed);
    wrongScope.scopeId = "e".repeat(64);
    expect(() => parseRetentionUploadResult(wrongScope, expected)).toThrow();
  });

  it("enforces the exact 512 KiB wire chunk boundary and rejects hidden authority fields", () => {
    const hello = structuredClone(fixture.publicParams.chunkHello);
    hello.length = RETENTION_CHUNK_BYTES;
    hello.contentBase64 = Buffer.alloc(RETENTION_CHUNK_BYTES).toString("base64");
    hello.chunkSha256 = "a".repeat(64);
    expect(Buffer.from(hello.contentBase64, "base64").byteLength).toBe(RETENTION_CHUNK_BYTES);
    expect(() => validateRetentionUploadParams("attachment/retention/upload/chunk", hello, {
      ...expected, size: RETENTION_CHUNK_BYTES, contentSha256: "a".repeat(64),
    })).not.toThrow();
    expect(() => validateRetentionUploadParams("attachment/retention/upload/chunk", {
      ...hello, length: RETENTION_CHUNK_BYTES + 1,
    }, { ...expected, size: RETENTION_CHUNK_BYTES + 1 })).toThrow();
    const forgedParams: unknown = {
      ...fixture.publicParams.read, trustedContext: { account: "forbidden" },
    };
    expect(() => validateRetentionUploadParams("attachment/retention/upload/read", forgedParams as RetentionUploadParamsV1, expected)).toThrow();
  });

  it("matches standard SHA-256 vectors and reads a 1 MiB source in bounded slices", async () => {
    expect(new Sha256Stream().update(new Uint8Array()).digestHex()).toBe(createHash("sha256").digest("hex"));
    const abc = new TextEncoder().encode("abc");
    expect(new Sha256Stream().update(abc).digestHex()).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, index) => index * 31 & 0xff);
    const reads: number[] = [];
    const digest = await hashBoundedSource({ size: bytes.length, async read(offset, length) {
      reads.push(length); return bytes.subarray(offset, offset + length);
    } }, () => true);
    expect(digest).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(Math.max(...reads)).toBeLessThanOrEqual(64 * 1024);
    expect(reads.reduce((sum, count) => sum + count, 0)).toBe(bytes.length);
  });
});
