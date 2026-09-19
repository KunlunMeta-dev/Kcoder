import assert from "node:assert/strict";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { assertWindowsX64Executable } from "./build-windows.mjs";

const packagedDir = process.env.KCODER_STUDIO_WINDOWS_PACKAGED_DIR;

test("Windows full desktop package contains native runtime, Gateway, renderer and no development credentials", {
  skip: packagedDir ? false : "set KCODER_STUDIO_WINDOWS_PACKAGED_DIR after packaging",
}, async () => {
  const root = resolve(packagedDir);
  const gatewayPackage = JSON.parse(await readFile(resolve(root, "resources/gateway/package.json"), "utf8"));
  assert.equal(gatewayPackage.type, "module", "external Gateway must declare its own module scope");
  for (const path of ["kcoder-studio.exe", "resources/bin/kcoder.exe", "resources/bin/kcoder-process-supervisor.exe", "resources/bin/chrome/chrome-win64/chrome.exe"]) {
    await assertWindowsX64Executable(resolve(root, path));
  }
  const bins = await readdir(resolve(root, "resources/bin"));
  assert.equal(bins.includes("kcoder"), false, "must not bundle a Linux sidecar in the Windows app");
  await access(resolve(root, "resources/renderer-dist/index.html"));
  await access(resolve(root, "resources/bin/chrome/chrome-win64/ABOUT"));
  await access(resolve(root, "resources/bin/chrome/.kcoder-chrome.json"));
  await access(resolve(root, "resources/gateway/src/server-config.js"));
  await access(resolve(root, "使用说明.txt"));
  const asar = await readFile(resolve(root, "resources/app.asar"));
  const contents = asar.toString("utf8");
  assert.match(contents, /packaged-paths\.mjs/);
  assert.equal(contents.includes("203.0.113.7"), false, "must not inherit the remote development target");
  assert.equal(contents.includes("remote-config.mjs"), false, "must not include the hard-coded remote development login");
  assert.ok((await stat(resolve(root, "resources/bin/kcoder.exe"))).size > 1_000_000);
  assert.match(await readFile(resolve(root, "resources/licenses/Wegent-Apache-2.0.txt"), "utf8"), /Apache License/);
});
