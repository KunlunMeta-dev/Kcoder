import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDesktopGatewayConfig } from "./gateway-env.mjs";

const stableToken = "desktop-auth-token-for-restart-stability-0123456789";

async function createPrivateDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "kcoder-studio-desktop-token-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("Desktop Gateway config reads a private token file and maps Desktop-only public settings", async t => {
  const directory = await createPrivateDirectory(t);
  const tokenFile = join(directory, "desktop-auth-token");
  await writeFile(tokenFile, `${stableToken}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);

  const launchEnvironment = {
    KCODER_STUDIO_DESKTOP_AUTH_TOKEN_FILE: tokenFile,
    KCODER_STUDIO_DESKTOP_PUBLIC_ORIGINS: "https://desktop.example",
    KCODER_STUDIO_DESKTOP_PUBLIC_ACCESS_URL: "https://desktop.example/gateway",
    KCODER_STUDIO_PUBLIC_ORIGINS: "https://generic.example",
    KCODER_STUDIO_PUBLIC_ACCESS_URL: "https://generic.example/gateway",
    KCODER_RELAY_SECRET: "relay-secret-must-not-reach-gateway",
    KCODER_RELAY_REGISTRATION_KEY: "relay-registration-key-must-not-reach-gateway",
    KCODER_STUDIO_DESKTOP_RELAY_REGISTRATION_KEY: "desktop-relay-registration-key-must-not-reach-gateway",
    kcoder_relay_registration_key: "mixed-case-key-must-not-reach-gateway",
  };
  const configured = await createDesktopGatewayConfig(launchEnvironment);

  assert.equal(configured.token, stableToken);
  assert.equal(configured.env.KCODER_STUDIO_PUBLIC_ORIGINS, "https://desktop.example");
  assert.equal(configured.env.KCODER_STUDIO_PUBLIC_ACCESS_URL, "https://desktop.example/gateway");
  assert.equal("KCODER_STUDIO_DESKTOP_AUTH_TOKEN_FILE" in configured.env, false);
  assert.equal("KCODER_STUDIO_DESKTOP_PUBLIC_ORIGINS" in configured.env, false);
  assert.equal("KCODER_STUDIO_DESKTOP_PUBLIC_ACCESS_URL" in configured.env, false);
  assert.equal(Object.keys(configured.env).some(key => key.startsWith("KCODER_RELAY_")), false);
  assert.equal("KCODER_STUDIO_DESKTOP_RELAY_REGISTRATION_KEY" in configured.env, false);
  assert.equal("kcoder_relay_registration_key" in configured.env, false);
  assert.equal(launchEnvironment.KCODER_STUDIO_PUBLIC_ORIGINS, "https://generic.example");
  assert.equal(launchEnvironment.KCODER_STUDIO_PUBLIC_ACCESS_URL, "https://generic.example/gateway");

  const inherited = await createDesktopGatewayConfig({
    KCODER_STUDIO_PUBLIC_ORIGINS: "https://existing.example",
    KCODER_STUDIO_PUBLIC_ACCESS_URL: "https://existing.example/gateway",
  });
  assert.match(inherited.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(inherited.env.KCODER_STUDIO_PUBLIC_ORIGINS, "https://existing.example");
  assert.equal(inherited.env.KCODER_STUDIO_PUBLIC_ACCESS_URL, "https://existing.example/gateway");

  const direct = await createDesktopGatewayConfig({ KCODER_STUDIO_DESKTOP_AUTH_TOKEN: stableToken });
  assert.match(direct.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(direct.token !== stableToken, "ambient Desktop token values never supply the owner secret");
  assert.equal("KCODER_STUDIO_DESKTOP_AUTH_TOKEN" in direct.env, false);
});

test("Desktop Gateway rejects a token file with group or other permissions", async t => {
  const directory = await createPrivateDirectory(t);
  const tokenFile = join(directory, "insecure-token");
  await writeFile(tokenFile, stableToken, { mode: 0o644 });
  await chmod(tokenFile, 0o644);

  await assert.rejects(
    createDesktopGatewayConfig({ KCODER_STUDIO_DESKTOP_AUTH_TOKEN_FILE: tokenFile }),
    /no group or other permissions/,
  );
});

test("Desktop Gateway rejects invalid, oversized, symlinked, and non-file token sources", async t => {
  const directory = await createPrivateDirectory(t);
  const invalidFile = join(directory, "invalid-token");
  const oversizedFile = join(directory, "oversized-token");
  const regularFile = join(directory, "regular-token");
  const linkFile = join(directory, "linked-token");
  const directorySource = join(directory, "directory-token");
  await writeFile(invalidFile, "short\n", { mode: 0o600 });
  await writeFile(oversizedFile, "x".repeat(513), { mode: 0o600 });
  await writeFile(regularFile, stableToken, { mode: 0o600 });
  await symlink(regularFile, linkFile);
  await mkdir(directorySource);

  await assert.rejects(
    createDesktopGatewayConfig({ KCODER_STUDIO_DESKTOP_AUTH_TOKEN_FILE: invalidFile }),
    /32 to 512 character URL-safe value/,
  );
  await assert.rejects(
    createDesktopGatewayConfig({ KCODER_STUDIO_DESKTOP_AUTH_TOKEN_FILE: oversizedFile }),
    /512 byte limit/,
  );
  await assert.rejects(
    createDesktopGatewayConfig({ KCODER_STUDIO_DESKTOP_AUTH_TOKEN_FILE: linkFile }),
    /cannot be a symbolic link/,
  );
  await assert.rejects(
    createDesktopGatewayConfig({ KCODER_STUDIO_DESKTOP_AUTH_TOKEN_FILE: directorySource }),
    /regular file/,
  );
  const directEnvToken = await createDesktopGatewayConfig({ KCODER_STUDIO_DESKTOP_AUTH_TOKEN: "short" });
  assert.match(directEnvToken.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(directEnvToken.token !== "short", "main does not read token values from launchd environment");
  assert.equal("KCODER_STUDIO_DESKTOP_AUTH_TOKEN" in directEnvToken.env, false);
});
