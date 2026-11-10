import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { repoRoot } from "./run-context.mjs";

// Historical consumers retain their original identity, never the split launcher's new bytes.
export const privateCandidateOriginals = Object.freeze({
  "home-samples-r2": { blob: "7dfa5795ad760533ffa3481568b8f326b3d9a48e", sha256: "9e365dfec6ec90a2e82756fbf32867a631a67b345e1b6fbbb3442e1e14cc86de" },
  "scroll-v1": { blob: "5610a2a05cfd594e2eb588d7772c819bd56699f4", sha256: "e89fa7bced4c8129a15c32182feda8d989d1e2d9d1fb9435207b7c303ac06d60" },
  "scroll-r2": { blob: "99526d59232dec44ff8f5b002f9f879542d3a568", sha256: "01d53217d11a5ea9578ebb2dcab21f08af6c03b6535fa961de08e7e3d8e94bbc" },
  "baseline-r2": { blob: "d228c6004c3241416fbfecaf0f25a2973c85c85d", sha256: "e00e5de23224a6b5937d890011f9bdb2a675c51a61eb800b38df4c7e6b6dd068" },
  "full-capture": { blob: "ff34de31061190f0838c37870ed4a3eaeb19a221", sha256: "ef212c83ecc12c94778e6ec709f62573f9a695874e738209a4695fdd8f67e2f5" },
  "source-maps": { blob: "266d56c188741bde2b7e7903a7bc427b4a311743", sha256: "b8de581284532d511fde72eb920ad5203d488fa2393da2e3e9130683757de2bc" },
});

export function readOriginalPrivateCandidate(key) {
  assert.ok(Object.hasOwn(privateCandidateOriginals, key), "unknown historical candidate identity");
  const expected = privateCandidateOriginals[key];
  const bytes = execFileSync("git", ["cat-file", "blob", expected.blob], {
    cwd: repoRoot, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256,
    "historical candidate Git bytes must retain their original SHA-256");
  return bytes.toString("utf8");
}
