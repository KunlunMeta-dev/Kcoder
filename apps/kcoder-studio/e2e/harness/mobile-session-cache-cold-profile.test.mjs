import assert from "node:assert/strict";
import test from "node:test";
import { startColdChromiumProfileEpoch } from "../suites/mobile/mobile-session-cache-cold-process.mjs";

test("cold process launch reuses the first Chromium profile and requires a new PID", async t => {
  const context = {};
  const launchCalls = [];
  let nextPid = 4_100;
  const launchChromium = async (_context, options) => {
    launchCalls.push(options);
    return {
      profileDir: `/run-context/chromium/${options.profileName}-profile`,
      child: { pid: ++nextPid },
    };
  };
  const firstChromium = await launchChromium(context, {
    label: "session-cache-chromium",
    profileName: "mobile-cache",
    startTimeoutMs: 60_000,
  });

  const coldChromium = await startColdChromiumProfileEpoch({
    context,
    profileName: "mobile-cache",
    firstProfileDir: firstChromium.profileDir,
    firstPid: firstChromium.child.pid,
    launchChromium,
  });

  assert.equal(launchCalls.length, 2);
  assert.deepEqual(launchCalls.map(call => call.profileName), ["mobile-cache", "mobile-cache"]);
  assert.equal(launchCalls[1].label, "session-cache-cold-open-chromium");
  assert.equal(coldChromium.profileDir, firstChromium.profileDir);
  assert.notEqual(coldChromium.child.pid, firstChromium.child.pid);

  await t.test("a different profile still fails the exact path assertion", async () => {
    await assert.rejects(startColdChromiumProfileEpoch({
      context,
      profileName: "session-cache-chromium",
      firstProfileDir: firstChromium.profileDir,
      firstPid: firstChromium.child.pid,
      launchChromium,
    }), /exact first-process private persistent profile/);
  });
});
