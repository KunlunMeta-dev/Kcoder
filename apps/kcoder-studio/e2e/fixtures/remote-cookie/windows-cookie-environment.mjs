import assert from "node:assert/strict";
import { win32 } from "node:path";

export function makeOwnedCookieEnvironment(source, root) {
  assert.match(root, /^[A-Za-z]:\\/, "local absolute owned root required");
  assert.equal(win32.resolve(root), root, "canonical owned root required");
  const directories = Object.fromEntries(["profile", "home", "cache", "temporary", "appdata", "localappdata"]
    .map((name) => [name, win32.join(root, name)]));
  const environment = {};
  for (const name of ["SystemRoot", "WINDIR", "PATH", "COMSPEC", "PATHEXT", "OS", "PROCESSOR_ARCHITECTURE"]) {
    const aliases = Object.getOwnPropertyNames(source).filter((key) => key.toUpperCase() === name.toUpperCase());
    const values = aliases.map((key) => source[key]).filter((value) => value !== undefined).map(String);
    assert.ok(new Set(values).size <= 1, "conflicting Windows environment aliases");
    if (values.length) environment[name] = values[0];
  }
  return { directories, environment: { ...environment,
    HOME: directories.home, USERPROFILE: directories.home, TEMP: directories.temporary, TMP: directories.temporary,
    APPDATA: directories.appdata, LOCALAPPDATA: directories.localappdata, XDG_CACHE_HOME: directories.cache,
    KCODER_COOKIE_CONFIGURATION: win32.join(root, "electron-config.json"),
  } };
}

export function redactOwnedCookieOutput(text, owner) {
  let result = String(text).slice(-8_192);
  for (const value of [`owned-login-${owner}`, `host/${owner}`, `legacy/${owner}`, `http/${owner}`]) {
    result = result.replaceAll(value, "[fixture-secret]");
  }
  return result;
}
