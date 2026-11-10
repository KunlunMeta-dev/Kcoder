import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { repoRoot } from "./run-context.mjs";

// Historical reviews must read their original bytes, never the new extracted launcher.
export const minuteBoundaryOriginal = Object.freeze({
  blob: "f5f72a843f8f4cd169b97d0b267fb26c3489f3b6",
  sha256: "9e0cee853545600ee33532312a3eb6e372f831201ce864c257908526e6cbfd16",
});

export function readOriginalMinuteBoundarySource() {
  const bytes = execFileSync("git", ["cat-file", "blob", minuteBoundaryOriginal.blob], {
    cwd: repoRoot, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(createHash("sha256").update(bytes).digest("hex"), minuteBoundaryOriginal.sha256,
    "historical minute-boundary source must retain its original SHA-256 identity");
  return bytes.toString("utf8");
}
