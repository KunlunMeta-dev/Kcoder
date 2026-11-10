import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  artifactTransferPlan,
  transferWindowsArtifact,
} from "./windows-artifact-transfer.mjs";
const valid = {
  owner: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  root: "D:\\owned",
  leaf: "package.exe",
  sha256: "a".repeat(64),
  bytes: 123,
};
test("artifact transfer rejects paths and budgets outside its owned finite layout", () => {
  assert.equal(artifactTransferPlan(valid).chunkBytes, 1024 * 1024);
  for (const patch of [
    { owner: "bad" },
    { root: "relative" },
    { root: "D:\\owned\\..\\other" },
    { leaf: "../private" },
    { sha256: "wrong" },
    { bytes: 2 ** 40 },
  ])
    assert.throws(() => artifactTransferPlan({ ...valid, ...patch }));
});
test("unknown copy is inspected by whole-file SHA before any upload or execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "kcoder-transfer-unit-"));
  try {
    const local = join(root, "artifact");
    const data = Buffer.from("owned");
    await writeFile(local, data);
    const sha256 = createHash("sha256").update(data).digest("hex");
    let calls = 0;
    const result = await transferWindowsArtifact({
      context: {
        writeArtifactJson() {
          throw Error("no transfer expected");
        },
      },
      ps: async () => {
        calls++;
        return JSON.stringify({ present: true, bytes: data.length, sha256 });
      },
      local,
      ...valid,
      sha256,
    });
    assert.equal(result.verified, true);
    assert.equal(result.reused, true);
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SCP data and bounded metadata frames keep the owner control channel separate", async () => {
  const root = await mkdtemp(join(tmpdir(), "kcoder-chunk-unit-"));
  try {
    const local = join(root, "artifact"),
      data = Buffer.alloc(1024 * 1024 + 17, 7);
    await writeFile(local, data);
    const sha256 = createHash("sha256").update(data).digest("hex");
    let writes = 0;
    const parts = new Map();
    const ps = async (script, input) => {
      assert.ok(!script.includes("[Console]::In.ReadToEnd()"));
      if (script.includes("present=$false"))
        return JSON.stringify({ present: false });
      if (script.includes("Artifact assembly owner changed")) {
        assert.ok(input.endsWith("\n"));
        assert.ok(input.split("\n").every((line) => line.length < 1024));
        return JSON.stringify({ verified: true, bytes: data.length, sha256 });
      }
      const match = script.match(/'(\d{6}\.part)'/);
      if (match) return JSON.stringify(parts.get(match[1]) || {});
      return "";
    };
    const result = await transferWindowsArtifact({
      context: {
        pathInState: (name) => join(root, name),
        seen: new Set(),
        async writeArtifactJson(name) {
          assert.ok(!this.seen.has(name));
          this.seen.add(name);
        },
      },
      ps,
      uploadPart: async (path, relative) => {
        const bytes = await readFile(path);
        assert.ok(bytes.length <= 1024 * 1024);
        parts.set(relative.split("/").at(-1), {
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
        writes++;
      },
      local,
      ...valid,
      sha256,
    });
    assert.equal(result.verified, true);
    assert.equal(writes, 2);
    assert.equal(result.chunks, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
