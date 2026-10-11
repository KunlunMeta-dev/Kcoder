import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertPathWithinApprovedRoots,
  readVerifiedMobileExportFile,
  verifyMobileExportManifestEnvelope,
} from "./mobile-web-export-input.mjs";

test("approved evidence paths reject wrong roots, unapproved private siblings, and symlink escapes", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "mobile-export-paths-"));
  try {
    const approvedPrivate = join(temporaryRoot, "target", "private-phone-ux-implementation");
    const unapprovedPrivate = join(temporaryRoot, "target", "private-other-work");
    const wrongRoot = join(temporaryRoot, "outside");
    await mkdir(approvedPrivate, { recursive: true });
    await mkdir(unapprovedPrivate, { recursive: true });
    await mkdir(wrongRoot, { recursive: true });

    const approvedBundle = join(approvedPrivate, "mobile-web-export-2050");
    const rejectedPrivateBundle = join(unapprovedPrivate, "mobile-web-export");
    const rejectedWrongBundle = join(wrongRoot, "mobile-web-export");
    const escapingLink = join(approvedPrivate, "escape-to-other-private");
    await mkdir(approvedBundle);
    await mkdir(rejectedPrivateBundle);
    await mkdir(rejectedWrongBundle);
    await symlink(rejectedPrivateBundle, escapingLink, "dir");

    assert.equal(await assertPathWithinApprovedRoots(approvedBundle, [approvedPrivate], "bundle"), approvedBundle);
    await assert.rejects(assertPathWithinApprovedRoots(rejectedPrivateBundle, [approvedPrivate], "bundle"), /outside every approved evidence root/);
    await assert.rejects(assertPathWithinApprovedRoots(rejectedWrongBundle, [approvedPrivate], "bundle"), /outside every approved evidence root/);
    await assert.rejects(assertPathWithinApprovedRoots(escapingLink, [approvedPrivate], "bundle"), /symbolic link|outside/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("export manifest envelope rejects a changed manifest and a tampered 37-file digest table", () => {
  const manifest = createManifestFixture();
  const originalBytes = Buffer.from(JSON.stringify(manifest));
  verifyMobileExportManifestEnvelope(manifest, originalBytes, sha256(originalBytes), "fixture");

  const changedBytes = Buffer.from(JSON.stringify({ ...manifest, sourceTreeSha256: "changed" }));
  assert.throws(() => verifyMobileExportManifestEnvelope(manifest, changedBytes, sha256(originalBytes), "fixture"), /manifest changed/);

  const tampered = structuredClone(manifest);
  tampered.bundleFiles[1].sha256 = "f".repeat(64);
  const tamperedBytes = Buffer.from(JSON.stringify(tampered));
  assert.throws(() => verifyMobileExportManifestEnvelope(tampered, tamperedBytes, sha256(tamperedBytes), "fixture"), /bundle table aggregate digest is invalid/);
});

test("bundle asset verification rejects missing and changed bytes", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "mobile-export-assets-"));
  try {
    const bundleRoot = join(temporaryRoot, "mobile-web-export");
    await mkdir(bundleRoot);
    const expectedBytes = Buffer.from("<!doctype html><title>fixture</title>");
    const entry = { path: "index.html", size: expectedBytes.length, sha256: sha256(expectedBytes) };
    await writeFile(join(bundleRoot, "index.html"), expectedBytes);
    assert.deepEqual(await readVerifiedMobileExportFile(bundleRoot, entry, "fixture"), expectedBytes);

    await rm(join(bundleRoot, "index.html"));
    await assert.rejects(readVerifiedMobileExportFile(bundleRoot, entry, "fixture"), /ENOENT/);

    await writeFile(join(bundleRoot, "index.html"), Buffer.alloc(expectedBytes.length, 0x78));
    await assert.rejects(readVerifiedMobileExportFile(bundleRoot, entry, "fixture"), /digest does not match/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

function createManifestFixture() {
  const indexBytes = Buffer.from("<html></html>");
  const entries = [{ path: "index.html", size: indexBytes.length, sha256: sha256(indexBytes) }];
  for (let index = 1; index < 37; index += 1) {
    const bytes = Buffer.from(`asset-${index}`);
    entries.push({ path: `assets/${index}.bin`, size: bytes.length, sha256: sha256(bytes) });
  }
  return {
    status: "complete",
    bundleFileCount: 37,
    bundleFiles: entries,
    bundleSha256: sha256(Buffer.from(JSON.stringify(entries))),
    indexHtmlSha256: sha256(indexBytes),
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
