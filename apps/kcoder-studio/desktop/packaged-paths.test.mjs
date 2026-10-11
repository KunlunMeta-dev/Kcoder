import assert from "node:assert/strict";
import test from "node:test";
import { packagedRuntimePaths } from "./packaged-paths.mjs";

test("packaged Windows runtime uses native .exe paths under a spaced install directory", () => {
  const paths = packagedRuntimePaths(String.raw`C:\Program Files\KCoder Studio\resources`, "win32");
  assert.equal(paths.kcoder, String.raw`C:\Program Files\KCoder Studio\resources\bin\kcoder.exe`);
  assert.equal(paths.supervisor, String.raw`C:\Program Files\KCoder Studio\resources\bin\kcoder-process-supervisor.exe`);
});

test("packaged Linux runtime keeps the existing non-Windows entry", () => {
  const paths = packagedRuntimePaths("/opt/kcoder/resources", "linux");
  assert.equal(paths.kcoder, "/opt/kcoder/resources/bin/kcoder");
  assert.equal(paths.supervisor, undefined);
});
