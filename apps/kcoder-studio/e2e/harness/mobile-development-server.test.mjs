import assert from "node:assert/strict";
import test from "node:test";
import { mobileDevelopmentArguments, startMobileDevelopmentServer } from "./mobile-development-server.mjs";

test("Metro arguments use an explicitly reserved port and leave development diagnostics enabled", () => {
  assert.deepEqual(mobileDevelopmentArguments("owned/expo", 12345), ["owned/expo", "start", "--web", "--localhost", "--port", "12345", "--max-workers", "4"]);
  for (const port of [0, -1, 65536, 1.5, "8081"]) assert.throws(() => mobileDevelopmentArguments("owned/expo", port), /reserved TCP port/);
});
test("Metro refuses shared source before writing or spawning anything", async () => {
  await assert.rejects(startMobileDevelopmentServer({ stateDir: "/owned/run/state" }, { mobileRoot: "/shared/mobile" }), /must belong to this run/);
});
