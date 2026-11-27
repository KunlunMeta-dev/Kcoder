import { verifyManifest } from "../../../scripts/release/artifact-manifest.mjs";
import assert from "node:assert/strict";
import { access, open, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const packagedDir = process.env.KCODER_STUDIO_REMOTE_PACKAGED_DIR;

test(
  "packaged Windows remote client contains a PE executable, ASAR entry, and attribution",
  { skip: packagedDir ? false : "set KCODER_STUDIO_REMOTE_PACKAGED_DIR after electron-builder" },
  async () => {
    const root = resolve(packagedDir);
    await verifyManifest(resolve(root, "resources"), { expectedCommit: process.env.KCODER_RELEASE_EXPECTED_COMMIT });
    const executable = resolve(root, "kcoder-studio-remote.exe");
    const asar = resolve(root, "resources", "app.asar");
    const supervisor = resolve(root, "resources", "bin", "kcoder-process-supervisor.exe");
    await access(executable, constants.R_OK);
    await access(asar, constants.R_OK);
    await access(supervisor, constants.R_OK);
    await access(resolve(root, "使用说明.txt"), constants.R_OK);
    const handle = await open(executable, "r");
    const header = Buffer.alloc(2);
    try {
      await handle.read(header, 0, header.length, 0);
    } finally {
      await handle.close();
    }
    assert.equal(header.toString("ascii"), "MZ");
    const supervisorHandle = await open(supervisor, "r");
    const supervisorHeader = Buffer.alloc(2);
    try {
      await supervisorHandle.read(supervisorHeader, 0, supervisorHeader.length, 0);
    } finally {
      await supervisorHandle.close();
    }
    assert.equal(supervisorHeader.toString("ascii"), "MZ");
    assert.ok((await stat(executable)).size > 100_000_000);
    assert.ok((await stat(asar)).size > 1_000);
    assert.match((await readFile(asar)).toString("utf8"), /remote-main\.mjs/);
    assert.match(
      await readFile(resolve(root, "resources", "licenses", "Wegent-Apache-2.0.txt"), "utf8"),
      /Apache License/,
    );
  },
);
