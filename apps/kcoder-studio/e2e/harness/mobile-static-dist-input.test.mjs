import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  copyOfficialMobileStaticDist,
  inspectOfficialMobileStaticDist,
} from "./mobile-static-dist-input.mjs";

const resourceCount = 37;
const baseToken = "/__kcoder_mobile_mount_v1__";

test("official Mobile static dist accepts exactly 37 valid resources", async () => {
  await withFixture(async fixture => {
    const inspected = await inspectOfficialMobileStaticDist({
      distRoot: fixture.distRoot,
      expectedManifestSha256: fixture.manifestSha256,
    });
    assert.equal(inspected.inputKind, "official-mobile-static-dist");
    assert.equal(inspected.resourceCount, resourceCount);
    assert.equal(inspected.baseToken, baseToken);
    assert.match(inspected.resourceTableSha256, /^[a-f0-9]{64}$/);
    assert.equal(inspected.resources.length, resourceCount);
  });
});

test("official Mobile static dist rejects a resource whose bytes changed", async () => {
  await withFixture(async fixture => {
    const path = join(fixture.distRoot, fixture.rows[0].path);
    const bytes = await readFile(path);
    bytes[0] ^= 0xff;
    await writeFile(path, bytes);
    await assert.rejects(
      inspectOfficialMobileStaticDist({ distRoot: fixture.distRoot, expectedManifestSha256: fixture.manifestSha256 }),
      /resource SHA-256 changed/,
    );
  });
});

test("official Mobile static dist rejects unlisted files", async () => {
  await withFixture(async fixture => {
    await writeFile(join(fixture.distRoot, "unlisted.txt"), "extra");
    await assert.rejects(
      inspectOfficialMobileStaticDist({ distRoot: fixture.distRoot, expectedManifestSha256: fixture.manifestSha256 }),
      /file set differs/,
    );
  });
});

test("official Mobile static dist rejects a manifest over the bound before parsing it", async () => {
  await withFixture(async fixture => {
    const path = join(fixture.distRoot, "kcoder-mobile-web.json");
    const original = await readFile(path);
    const bytes = Buffer.concat([original, Buffer.alloc(1024 * 1024 + 1 - original.length, 0x20)]);
    await writeFile(path, bytes);
    await assert.rejects(
      inspectOfficialMobileStaticDist({ distRoot: fixture.distRoot, expectedManifestSha256: sha256(bytes) }),
      /manifest exceeds the size bound/,
    );
  });
});

test("official Mobile static dist rejects an oversized resource from lstat before reading it", async () => {
  await withFixture(async fixture => {
    const path = join(fixture.distRoot, fixture.rows[0].path);
    await truncate(path, 64 * 1024 * 1024 + 1);
    await assert.rejects(
      inspectOfficialMobileStaticDist({ distRoot: fixture.distRoot, expectedManifestSha256: fixture.manifestSha256 }),
      /resource exceeds the size bound/,
    );
  });
});

test("official Mobile static dist rejects path traversal from its manifest", async () => {
  await withFixture(async fixture => {
    const manifestPath = join(fixture.distRoot, "kcoder-mobile-web.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files[0].path = "../outside.bin";
    const bytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(manifestPath, bytes);
    await assert.rejects(
      inspectOfficialMobileStaticDist({ distRoot: fixture.distRoot, expectedManifestSha256: sha256(bytes) }),
      /unsafe segment/,
    );
  });
});

test("official Mobile static dist rejects symlinked resources", async () => {
  await withFixture(async fixture => {
    const row = fixture.rows[0];
    const path = join(fixture.distRoot, row.path);
    const backup = `${path}.saved`;
    const bytes = await readFile(path);
    await rm(path);
    await writeFile(backup, bytes);
    await symlink(backup, path);
    await assert.rejects(
      inspectOfficialMobileStaticDist({ distRoot: fixture.distRoot, expectedManifestSha256: fixture.manifestSha256 }),
      /symlink/,
    );
  });
});

test("owned static-dist copy stays inside RunContext state with exact owner and modes", async () => {
  await withFixture(async fixture => {
    const stateDir = join(fixture.root, "state");
    await mkdir(stateDir, { mode: 0o700 });
    await chmod(stateDir, 0o700);
    const registered = [];
    const context = {
      stateDir,
      pathInState(...parts) { return join(stateDir, ...parts); },
      registerTemporaryDirectory(label, path) { registered.push({ label, path }); },
    };
    const copied = await copyOfficialMobileStaticDist(context, {
      distRoot: fixture.distRoot,
      expectedManifestSha256: fixture.manifestSha256,
      outputName: "current-mobile-dist",
    });
    assert.equal(copied.ownedCopyVerified, true);
    assert.equal(copied.sourceStableDuringCopy, true);
    assert.equal(copied.resourceCount, resourceCount);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].path, copied.ownedRoot);
    assert.equal(copied.ownedRoot.startsWith(`${stateDir}/`), true);
    const rootInfo = await lstat(copied.ownedRoot);
    assert.equal(rootInfo.mode & 0o777, 0o700);
    if (typeof process.getuid === "function") assert.equal(rootInfo.uid, process.getuid());
    const ownedFile = await lstat(join(copied.ownedRoot, fixture.rows[0].path));
    assert.equal(ownedFile.mode & 0o777, 0o600);
    if (typeof process.getuid === "function") assert.equal(ownedFile.uid, process.getuid());
  });
});

test("owned static-dist copy rejects a RunContext path outside state before writing", async () => {
  await withFixture(async fixture => {
    const stateDir = join(fixture.root, "state");
    const outside = join(fixture.root, "outside");
    await mkdir(stateDir, { mode: 0o700 });
    const context = {
      stateDir,
      pathInState() { return outside; },
      registerTemporaryDirectory() { assert.fail("outside path must not be registered"); },
    };
    await assert.rejects(
      copyOfficialMobileStaticDist(context, {
        distRoot: fixture.distRoot,
        expectedManifestSha256: fixture.manifestSha256,
      }),
      /inside this RunContext state/,
    );
    await assert.rejects(lstat(outside), { code: "ENOENT" });
  });
});

async function withFixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "mobile-static-dist-contract-"));
  try {
    const distRoot = join(root, "dist");
    await mkdir(distRoot, { mode: 0o700 });
    const rows = [];
    for (let index = 0; index < resourceCount; index += 1) {
      const path = `assets/group-${String(index % 4)}/resource-${String(index).padStart(2, "0")}.bin`;
      const bytes = Buffer.from(`fixture-resource-${index}`);
      const fullPath = join(distRoot, path);
      await mkdir(dirname(fullPath), { recursive: true, mode: 0o700 });
      await writeFile(fullPath, bytes, { mode: 0o600 });
      rows.push({
        path,
        size: bytes.length,
        sha256: sha256(bytes),
        text: false,
        replacements: 0,
      });
    }
    const manifestBytes = Buffer.from(JSON.stringify({ version: 1, baseToken, files: rows }));
    await writeFile(join(distRoot, "kcoder-mobile-web.json"), manifestBytes, { mode: 0o600 });
    await callback({ root, distRoot, rows, manifestSha256: sha256(manifestBytes) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
