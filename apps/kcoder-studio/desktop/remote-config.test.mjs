import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  DEFAULT_REMOTE_SERVER_URL,
  DEFAULT_REMOTE_TOKEN,
  loginRemoteGateway,
  resolveRemoteClientOptions,
} from "./remote-config.mjs";

test("remote client defaults to the current Tailscale server and token", () => {
  assert.deepEqual(resolveRemoteClientOptions({}, []), {
    origin: DEFAULT_REMOTE_SERVER_URL,
    initialUrl: `${DEFAULT_REMOTE_SERVER_URL}/`,
    token: DEFAULT_REMOTE_TOKEN,
  });
});

test("remote client accepts explicit environment and command line overrides", () => {
  assert.deepEqual(
    resolveRemoteClientOptions(
      { KCODER_STUDIO_REMOTE_URL: "https://env.example:9443/ignored", KCODER_STUDIO_REMOTE_TOKEN: "env" },
      ["--server-url=http://100.80.0.2:5000/workbench?tab=one", "--token", "cli"],
    ),
    {
      origin: "http://100.80.0.2:5000",
      initialUrl: "http://100.80.0.2:5000/workbench?tab=one",
      token: "cli",
    },
  );
});

test("remote client rejects unsafe or unsupported server URLs", () => {
  assert.throws(
    () => resolveRemoteClientOptions({ KCODER_STUDIO_REMOTE_URL: "file:///tmp/index.html" }, []),
    /HTTP 或 HTTPS/,
  );
  assert.throws(
    () => resolveRemoteClientOptions({ KCODER_STUDIO_REMOTE_URL: "http://user:pass@example.test" }, []),
    /不能包含用户名或密码/,
  );
});

test("remote login sends the token and returns only the opaque session value", async (t) => {
  let receivedBody = "";
  const server = createServer((request, response) => {
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      receivedBody += chunk;
    });
    request.on("end", () => {
      response.writeHead(303, {
        location: "/",
        "set-cookie": "kcoder_studio_session=opaque%2Fvalue; HttpOnly; SameSite=Strict; Path=/",
      });
      response.end();
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const address = server.address();
  const cookie = await loginRemoteGateway({
    origin: `http://127.0.0.1:${address.port}`,
    token: "test token",
  });
  assert.equal(cookie, "opaque/value");
  assert.equal(receivedBody, "token=test+token");
});
