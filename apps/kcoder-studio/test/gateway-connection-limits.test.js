import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Execute the actual startup validation without starting a Gateway or reading credentials.
const source = readFileSync(new URL("../dev-server.mjs", import.meta.url), "utf8");
const start = source.indexOf("const maxConnections =");
const end = source.indexOf("// Keep enough headroom", start);
assert.ok(start >= 0 && end > start);
const limits = env => JSON.parse(runInNewContext(
  `${source.slice(start, end)}; JSON.stringify({maxConnections, maxBrowserConnections})`,
  { process: { env } },
));

test("Gateway defaults to 256 total sockets and keeps the browser-channel limit", () => {
  assert.deepEqual(limits({}), { maxConnections: 256, maxBrowserConnections: 4 });
});

test("explicit connection limits still override defaults and reject invalid values", () => {
  assert.deepEqual(limits({ KCODER_STUDIO_MAX_CONNECTIONS: "16" }), {
    maxConnections: 16, maxBrowserConnections: 4,
  });
  assert.deepEqual(limits({ KCODER_STUDIO_MAX_CONNECTIONS: "128" }), {
    maxConnections: 128, maxBrowserConnections: 4,
  });
  assert.deepEqual(limits({ KCODER_STUDIO_MAX_CONNECTIONS: "64" }), {
    maxConnections: 64, maxBrowserConnections: 4,
  });
  assert.deepEqual(limits({ KCODER_STUDIO_MAX_CONNECTIONS: "256" }), {
    maxConnections: 256, maxBrowserConnections: 4,
  });
  for (const value of ["0", "257", "1.5", "invalid"]) {
    assert.throws(() => limits({ KCODER_STUDIO_MAX_CONNECTIONS: value }), /integer from 1 to 256/);
  }
  assert.throws(() => limits({ KCODER_STUDIO_MAX_BROWSER_CONNECTIONS: "17" }), /MAX_BROWSER_CONNECTIONS/);
});
