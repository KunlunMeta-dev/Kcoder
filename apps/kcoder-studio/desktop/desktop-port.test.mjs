import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveDesktopPort } from "./desktop-port.mjs";

test("persists one randomly selected loopback port across desktop launches", async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), "kcoder-desktop-port-"));
  const first = await resolveDesktopPort({ userDataDir });
  const second = await resolveDesktopPort({ userDataDir });

  assert.equal(second, first);
  assert.equal((await readFile(join(userDataDir, "gateway-port"), "utf8")).trim(), String(first));
  assert.ok(first >= 42_000 && first < 55_000);
});

test("validates an explicit stable desktop port", async () => {
  assert.equal(
    await resolveDesktopPort({ userDataDir: "/unused", configuredPort: "45123" }),
    45_123,
  );
  await assert.rejects(
    resolveDesktopPort({ userDataDir: "/unused", configuredPort: "not-a-port" }),
    /KCODER_STUDIO_DESKTOP_PORT/,
  );
});

