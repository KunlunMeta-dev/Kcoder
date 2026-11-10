import assert from "node:assert/strict";
import test from "node:test";
import { completeDevelopmentSockets } from "./nginx-development-sockets.mjs";

const original = `location = /g/dev/hot {
 proxy_pass http://127.0.0.1:14179/hot;
 proxy_set_header Upgrade $http_upgrade;
 proxy_set_header Connection "upgrade";
 proxy_set_header X-Owned-Header opaque;
}
sub_filter 'window.location.host}/hot' 'window.location.host}/g/dev/hot';`;
test("adds both mounted reload transport and bundle rewrite, retaining proxy authorization and headers", () => {
  const result = completeDevelopmentSockets(original, "/g/dev");
  assert.ok(result.includes("location = /g/dev/message {"));
  assert.ok(result.includes("proxy_pass http://127.0.0.1:14179/message;"));
  assert.ok(result.includes("sub_filter 'window.location.host}/message' 'window.location.host}/g/dev/message';"));
  assert.equal(result.match(/X-Owned-Header opaque/g).length, 2);
  assert.equal(result.includes("location = /message"), false);
  assert.ok(result.includes(`sub_filter 'href="/__kcoder_mobile_mount_v1__/' 'href="/g/dev/mobile/';`));
  assert.equal(completeDevelopmentSockets(result, "/g/dev"), result);
});
test("refuses incomplete proxies, unexpected existing routes and unsafe mounts", () => {
  for (const config of ["", original.replace("Upgrade $http_upgrade", "Unsupported unused"), original.replace("sub_filter", "unrecognized")]) {
    assert.throws(() => completeDevelopmentSockets(config, "/g/dev"));
  }
  assert.throws(() => completeDevelopmentSockets(original + "\nlocation = /g/dev/message { deny all; }", "/g/dev"));
  for (const mount of ["/", "/g/a;b", "/g/a/../b", "/g/a\n"]) assert.throws(() => completeDevelopmentSockets(original, mount));
});
