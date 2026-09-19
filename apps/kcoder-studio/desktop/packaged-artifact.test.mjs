import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const packagedDir = process.env.KCODER_STUDIO_PACKAGED_DIR;

test(
  "packaged Linux directory contains its renderer, executable sidecar, and complete third-party notices",
  { skip: packagedDir ? false : "set KCODER_STUDIO_PACKAGED_DIR after electron-builder" },
  async () => {
    const root = resolve(packagedDir);
    const gatewayPackage = JSON.parse(await readFile(resolve(root, "resources/gateway/package.json"), "utf8"));
    assert.equal(gatewayPackage.type, "module", "external Gateway must declare its own module scope");
    await access(resolve(root, "kcoder-studio"), constants.X_OK);
    await access(resolve(root, "resources", "bin", "kcoder"), constants.X_OK);
    await access(resolve(root, "resources", "bin", "chrome", "chrome-linux64", "chrome"), constants.X_OK);
    await access(resolve(root, "resources", "bin", "chrome", "chrome-linux64", "ABOUT"), constants.R_OK);
    await access(resolve(root, "resources", "gateway", "dev-server.mjs"), constants.R_OK);
    await access(resolve(root, "resources", "renderer-dist", "index.html"), constants.R_OK);
    const license = await readFile(
      resolve(root, "resources", "licenses", "Wegent-Apache-2.0.txt"),
      "utf8",
    );
    const provenance = await readFile(
      resolve(root, "resources", "licenses", "Wegent-UPSTREAM.md"),
      "utf8",
    );
    const changes = await readFile(
      resolve(root, "resources", "licenses", "Wegent-KCODER_CHANGES.md"),
      "utf8",
    );
    assert.match(license, /Apache License/);
    assert.match(provenance, /Third-party source notice/);
    for (const [content, source] of [
      [license, "LICENSE.upstream"],
      [provenance, "UPSTREAM.md"],
      [changes, "KCODER_CHANGES.md"],
    ]) {
      assert.equal(
        content,
        await readFile(new URL(`../renderer/${source}`, import.meta.url), "utf8"),
        `packaged ${source} must preserve the complete source notice`,
      );
    }
    assert.match(changes, /^# KCoder Studio /);
    const sidecarSize = (await stat(resolve(root, "resources", "bin", "kcoder"))).size;
    assert.ok(sidecarSize > 1_000_000);
    assert.ok(sidecarSize < 100_000_000, `release sidecar is unexpectedly large: ${sidecarSize}`);
  },
);
