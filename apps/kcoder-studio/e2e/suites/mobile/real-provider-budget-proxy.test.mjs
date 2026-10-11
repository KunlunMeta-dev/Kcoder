import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { runE2E } from "../../harness/run-context.mjs";
import { startProviderBudgetProxy } from "./real-provider-budget-proxy.mjs";

test("forwards no more than four requests and blocks redirects", async () => {
  let proxy;
  await runE2E(
    import.meta.url,
    { testId: "real-provider-budget-proxy-contract", tier: "harness-unit" },
    async (context) => {
      let upstream;
      let redirectSink;
      context.addCleanup("assert dummy upstream closed", async () => {
        assert.equal(upstream?.listening, false);
      });
      context.addCleanup("assert redirect sink closed", async () => {
        assert.equal(redirectSink?.listening, false);
      });

      let redirectHits = 0;
      redirectSink = http.createServer((_request, response) => {
        redirectHits += 1;
        response.end("redirect should never be followed");
      });
      const redirectPort = await listenOwned(
        context,
        "budget-proxy-redirect-sink",
        redirectSink,
      );

      const seen = [];
      upstream = http.createServer((request, response) => {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
          seen.push({
            url: request.url,
            authHeader: request.headers["x-api-key"],
            body: Buffer.concat(chunks).toString("utf8"),
            host: request.headers.host,
            originalConnectionHeaderForwarded:
              request.headers.connection === "keep-alive, x-hop-test",
            connectionTokenForwarded: request.headers["x-hop-test"] !== undefined,
            forgedHostForwarded: request.headers.host === "attacker.invalid",
          });
          if (request.url.includes("/v1/redirect")) {
            response.writeHead(302, {
              location: `http://127.0.0.1:${redirectPort}/should-not-follow`,
            });
            response.end("redirect response");
          } else if (request.url.includes("/v1/stream")) {
            response.writeHead(200, {
              "content-type": "text/event-stream",
              "x-upstream-test": "preserved",
            });
            response.write("data: first\n\n");
            setTimeout(() => response.end("data: second\n\n"), 20);
          } else {
            response.writeHead(200, { "content-type": "application/json" });
            response.end('{"ok":true}');
          }
        });
      });
      const upstreamPort = await listenOwned(
        context,
        "budget-proxy-dummy-upstream",
        upstream,
      );

      context.addCleanup("assert budget proxy closed", async () => {
        assert.equal(proxy?.isListening, false);
      });
      proxy = await startProviderBudgetProxy(context, {
        upstreamEndpoint: `http://127.0.0.1:${upstreamPort}/base?approved=1`,
        maxForwardedRequests: 4,
        label: "budget-proxy-cap-contract",
      });

      const stream = await post(
        proxy.port,
        "/v1/stream?probe=keep",
        "body-one",
        {
          connection: "keep-alive, x-hop-test",
          "x-hop-test": "dummy-hop-secret",
          host: "attacker.invalid",
        },
      );
      assert.equal(stream.statusCode, 200);
      assert.equal(stream.headers["content-type"], "text/event-stream");
      assert.equal(stream.headers["x-upstream-test"], "preserved");
      assert.equal(stream.body, "data: first\n\ndata: second\n\n");
      assert.equal(seen[0].host, `127.0.0.1:${upstreamPort}`);
      assert.equal(seen[0].originalConnectionHeaderForwarded, false);
      assert.equal(seen[0].connectionTokenForwarded, false);
      assert.equal(seen[0].forgedHostForwarded, false);

      const second = await post(proxy.port, "/v1/ok", "body-two");
      assert.equal(second.statusCode, 200);

      const redirect = await post(proxy.port, "/v1/redirect", "body-three");
      assert.equal(redirect.statusCode, 502);
      assert.equal(redirect.headers.location, undefined);
      assert.equal(redirectHits, 0);

      const fourth = await post(proxy.port, "/v1/ok", "body-four");
      assert.equal(fourth.statusCode, 200);

      const fifth = await post(proxy.port, "/v1/never-forward", "body-five");
      assert.equal(fifth.statusCode, 429);
      assert.equal(seen.length, 4);
      assert.deepEqual(
        seen.map((entry) => entry.url),
        [
          "/base?approved=1/v1/stream?probe=keep",
          "/base?approved=1/v1/ok",
          "/base?approved=1/v1/redirect",
          "/base?approved=1/v1/ok",
        ],
      );
      assert.ok(seen.every((entry) => entry.authHeader === "dummy-api-key"));
      assert.equal(seen.some((entry) => entry.body === "body-five"), false);
      assert.deepEqual(proxy.snapshot(), {
        forwardedRequests: 4,
        forwardedPostRequests: 4,
        locallyRejectedRequests: 1,
        blockedRedirectResponses: 1,
        inFlightRequests: 0,
      });
      await context.writeArtifactJson("budget-proxy-contract.json", {
        forwardedRequests: 4,
        fifthRequestRejectedLocally: true,
        redirectsFollowed: false,
        streamingResponsePreserved: true,
        inFlightRequestsAtEnd: 0,
      });
    },
  );
  assert.equal(proxy.isListening, false);
});

test("checks and consumes the forwarding budget before concurrent requests can egress", async () => {
  let proxy;
  await runE2E(
    import.meta.url,
    { testId: "real-provider-budget-proxy-concurrent-cap", tier: "harness-unit" },
    async (context) => {
      let upstream;
      let forwarded = 0;
      context.addCleanup("assert concurrent dummy upstream closed", async () => {
        assert.equal(upstream?.listening, false);
      });
      upstream = http.createServer((request, response) => {
        request.resume();
        request.on("end", () => {
          forwarded += 1;
          setTimeout(() => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end('{"ok":true}');
          }, 25);
        });
      });
      const upstreamPort = await listenOwned(
        context,
        "budget-proxy-concurrent-upstream",
        upstream,
      );
      context.addCleanup("assert concurrent budget proxy closed", async () => {
        assert.equal(proxy?.isListening, false);
      });
      proxy = await startProviderBudgetProxy(context, {
        upstreamEndpoint: `http://127.0.0.1:${upstreamPort}/base`,
        maxForwardedRequests: 4,
        label: "budget-proxy-concurrent-cap",
      });

      const responses = await Promise.all(
        Array.from({ length: 9 }, (_, index) =>
          post(proxy.port, `/v1/concurrent-${index}`, `body-${index}`),
        ),
      );
      assert.equal(responses.filter((response) => response.statusCode === 200).length, 4);
      assert.equal(responses.filter((response) => response.statusCode === 429).length, 5);
      assert.equal(forwarded, 4);
      assert.deepEqual(proxy.snapshot(), {
        forwardedRequests: 4,
        forwardedPostRequests: 4,
        locallyRejectedRequests: 5,
        blockedRedirectResponses: 0,
        inFlightRequests: 0,
      });
      await context.writeArtifactJson("budget-proxy-concurrent-cap.json", {
        concurrentClientRequests: 9,
        upstreamForwarded: forwarded,
        localBudgetRejections: 5,
        hardCap: 4,
      });
    },
  );
  assert.equal(proxy.isListening, false);
});

test("keeps TLS certificate verification enabled even when Node has a bypass env", async () => {
  let proxy;
  await runE2E(
    import.meta.url,
    { testId: "real-provider-budget-proxy-tls-verification", tier: "harness-unit" },
    async (context) => {
      const certDir = context.pathInState("self-signed-tls");
      await mkdir(certDir, { recursive: true, mode: 0o700 });
      const keyPath = resolve(certDir, "key.pem");
      const certPath = resolve(certDir, "cert.pem");
      const certificate = context.spawnOwned(
        "budget-proxy-self-signed-certificate",
        "/usr/bin/openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
          "-keyout",
          keyPath,
          "-out",
          certPath,
        ],
        { cwd: context.stateDir, env: context.isolatedEnvironment({ HOME: context.stateDir }) },
      );
      const certificateExitCode = await new Promise((resolveExit, reject) => {
        if (certificate.exitCode !== null) {
          resolveExit(certificate.exitCode);
          return;
        }
        certificate.once("error", reject);
        certificate.once("exit", resolveExit);
      });
      assert.equal(certificateExitCode, 0);

      let acceptedRequests = 0;
      const upstream = https.createServer(
        { key: await readFile(keyPath), cert: await readFile(certPath) },
        (_request, response) => {
          acceptedRequests += 1;
          response.end("must not reach the untrusted TLS endpoint");
        },
      );
      const upstreamPort = await listenOwned(
        context,
        "budget-proxy-untrusted-tls-upstream",
        upstream,
      );
      proxy = await startProviderBudgetProxy(context, {
        upstreamEndpoint: `https://127.0.0.1:${upstreamPort}/base`,
        maxForwardedRequests: 4,
        label: "budget-proxy-tls-verification",
      });

      const previousTlsBypass = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      try {
        const response = await post(proxy.port, "/v1/messages", "dummy-body");
        assert.equal(response.statusCode, 502);
        assert.equal(acceptedRequests, 0);
      } finally {
        if (previousTlsBypass === undefined) {
          delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        } else {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsBypass;
        }
      }
      await context.writeArtifactJson("budget-proxy-tls-verification.json", {
        globalNodeTlsBypassWasSetDuringProbe: true,
        untrustedUpstreamHttpRequestsAccepted: acceptedRequests,
        certificateVerificationPreventedHttpRequest: acceptedRequests === 0,
        proxyReturnedSafeBadGateway: true,
      });
    },
  );
  assert.equal(proxy.isListening, false);
});

test("closes an active streaming response and its upstream socket", async () => {
  let proxy;
  await runE2E(
    import.meta.url,
    { testId: "real-provider-budget-proxy-stream-cleanup", tier: "harness-unit" },
    async (context) => {
      let upstream;
      let upstreamResponseClosed;
      let resolveUpstreamResponseClosed;
      upstreamResponseClosed = new Promise((resolve) => {
        resolveUpstreamResponseClosed = resolve;
      });
      context.addCleanup("assert streaming upstream closed", async () => {
        assert.equal(upstream?.listening, false);
      });
      upstream = http.createServer((request, response) => {
        request.resume();
        request.on("end", () => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write("data: stream-open\n\n");
          response.once("close", resolveUpstreamResponseClosed);
        });
      });
      const upstreamPort = await listenOwned(
        context,
        "budget-proxy-stream-upstream",
        upstream,
      );

      context.addCleanup("assert streaming budget proxy closed", async () => {
        assert.equal(proxy?.isListening, false);
      });
      proxy = await startProviderBudgetProxy(context, {
        upstreamEndpoint: `http://127.0.0.1:${upstreamPort}/base`,
        maxForwardedRequests: 4,
        label: "budget-proxy-stream-cleanup",
      });
      const active = await postUntilFirstChunk(proxy.port, "/v1/hold");
      assert.equal(active.firstChunk.toString("utf8"), "data: stream-open\n\n");
      assert.equal(proxy.snapshot().inFlightRequests, 1);

      await proxy.close();
      await Promise.race([
        upstreamResponseClosed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("dummy upstream stream did not close")), 1_000),
        ),
      ]);
      assert.equal(proxy.isListening, false);
      assert.equal(proxy.snapshot().inFlightRequests, 0);
      await context.writeArtifactJson("budget-proxy-stream-cleanup.json", {
        activeStreamWasClosed: true,
        upstreamResponseClosed: true,
        proxyListeningAfterClose: false,
        inFlightRequestsAfterClose: 0,
      });
    },
  );
  assert.equal(proxy.isListening, false);
});

async function listenOwned(context, label, server) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  context.registerPort(label, address.port);
  context.addCleanup(`close ${label}`, () => closeServer(server));
  return address.port;
}

async function closeServer(server) {
  if (!server?.listening) return;
  const closed = new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections?.();
  await closed;
}

function post(port, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-api-key": "dummy-api-key",
          ...extraHeaders,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("error", reject);
        response.once("end", () =>
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

function postUntilFirstChunk(port, path) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": 5,
          "x-api-key": "dummy-api-key",
        },
      },
      (response) => {
        response.on("data", (chunk) => {
          if (settled) return;
          settled = true;
          resolve({ request, response, firstChunk: Buffer.from(chunk) });
        });
        response.on("error", (error) => {
          if (!settled) reject(error);
        });
        response.on("aborted", () => {
          if (!settled) reject(new Error("stream aborted before first chunk"));
        });
      },
    );
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
    request.end("hello");
  });
}
