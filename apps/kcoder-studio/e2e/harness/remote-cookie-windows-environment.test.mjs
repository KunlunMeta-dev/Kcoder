import assert from "node:assert/strict";
import test from "node:test";
import { makeOwnedCookieEnvironment, redactOwnedCookieOutput } from "../fixtures/remote-cookie/windows-cookie-environment.mjs";

const root = "C:\\owned-fixture\\cookie-unique";
test("Cookie worker collapses equal PATH/Path aliases before the actual supervisor protocol", () => {
  const source = { PATH: "C:\\Windows\\System32", Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows", windir: "C:\\Windows" };
  const output = makeOwnedCookieEnvironment(source, root);
  assert.equal(output.environment.PATH, source.PATH);
  assert.equal(output.environment.Path, undefined);
  const names = Object.keys(output.environment).map((name) => name.toUpperCase());
  assert.equal(new Set(names).size, names.length);
  assert.equal(output.environment.WINDIR, source.windir);
  assert.deepEqual(source, { PATH: "C:\\Windows\\System32", Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows", windir: "C:\\Windows" });
});
test("Cookie worker refuses conflicting case aliases instead of choosing the first", () => {
  assert.throws(() => makeOwnedCookieEnvironment({ PATH: "one", Path: "another" }, root), /conflicting Windows environment aliases/);
});
test("Cookie worker reads only allowed inherited values and puts all writable paths inside its root", () => {
  let secretReads = 0;
  const source = { Path: "C:\\Windows\\System32", USERPROFILE: "C:\\Users\\personal", NODE_OPTIONS: "untrusted-preload", ELECTRON_RUN_AS_NODE: "1" };
  Object.defineProperty(source, "API_KEY", { enumerable: true, get() { secretReads++; throw new Error("private value must not be read"); } });
  const { environment, directories } = makeOwnedCookieEnvironment(source, root);
  assert.equal(secretReads, 0);
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(environment.API_KEY, undefined);
  assert.equal(environment.USERPROFILE, root + "\\home");
  for (const path of Object.values(directories)) assert.ok(path.startsWith(root + "\\"));
  for (const name of ["HOME", "USERPROFILE", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "XDG_CACHE_HOME", "KCODER_COOKIE_CONFIGURATION"]) assert.ok(environment[name].startsWith(root + "\\"));
  assert.throws(() => makeOwnedCookieEnvironment({}, "\\\\server\\shared"), /local absolute owned root/);
  assert.throws(() => makeOwnedCookieEnvironment({}, "relative"), /local absolute owned root/);
  assert.throws(() => makeOwnedCookieEnvironment({}, "C:\\owned\\..\\peer"), /canonical owned root/);
});
test("Cookie worker retains a bounded native failure tail with fixture credentials removed", () => {
  const owner = "fixture-owner";
  const result = redactOwnedCookieOutput("discard".repeat(2_000) + " error owned-login-fixture-owner host/fixture-owner legacy/fixture-owner http/fixture-owner; protocol duplicate PATH", owner);
  assert.ok(result.length <= 8_192);
  for (const value of ["owned-login-fixture-owner", "host/fixture-owner", "legacy/fixture-owner", "http/fixture-owner"]) assert.equal(result.includes(value), false);
  assert.match(result, /protocol duplicate PATH/);
  assert.match(result, /\[fixture-secret\]/);
});
