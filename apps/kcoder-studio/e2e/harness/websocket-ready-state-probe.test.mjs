import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { startChromium } from "./chromium.mjs";
import { RunContext } from "./run-context.mjs";
import {
  configureWebSocketReadyStateProbe,
  installWebSocketReadyStateProbe,
  installWebSocketReadyStateProbeInPage,
  readWebSocketReadyStateProbe,
} from "./websocket-ready-state-probe.mjs";

const chromiumAvailable =
  process.platform === "linux" &&
  process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === "1";

test(
  "post-navigation readyState probe captures the routed app socket and fail-closed send gate",
  {
    skip: chromiumAvailable
      ? false
      : "需要在隔离 VM 中显式设置 KCODER_E2E_CHROMIUM_NO_SANDBOX=1",
    timeout: 90_000,
  },
  async () => {
    const context = await RunContext.create(import.meta.url, {
      testId: "websocket-ready-state-probe-minimal",
      modelPolicy:
        "model-independent harness check; owned loopback HTTP/WebSocket, Chromium, and Playwright route only; no Expo, Gateway, app-server, Provider, or credentials",
      retainSuccessLogs: true,
    });
    const fixture = createLoopbackHttpWebSocketFixture();
    const routeEvidence = {
      routeCreated: false,
      upstreamSocketCreated: false,
      clientToUpstreamMessages: 0,
      upstreamToClientMessages: 0,
    };
    const evidence = {
      boundary:
        "Chromium page WebSocket is routed by Playwright to an owned loopback WebSocket server; unforced/effective values describe the same browser-facing routed object, not upstream physical state",
      route: routeEvidence,
      fixture: null,
      replacementDetection: null,
      afterPostNavigationInstall: null,
      afterConnect: null,
      whileForcedClosed: null,
      afterRestoreAndSend: null,
    };
    let browser;
    let page;
    let replacementPage;
    let replacementPageErrors = [];
    let replacementDiagnostics = null;
    let failure;

    try {
      await listenLoopback(fixture.server);
      const address = fixture.server.address();
      assert.ok(address && typeof address === "object");
      context.registerPort("websocket-ready-state-http", address.port);
      fixture.setOrigin(`http://127.0.0.1:${address.port}`);
      context.addCleanup("close owned ready-state HTTP and WebSocket fixture", () =>
        fixture.close(),
      );

      browser = await startChromium(context, {
        label: "ready-state-probe-chromium",
      });

      replacementPage = await browser.newPage({
        viewport: { width: 360, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      });
      context.addCleanup("close replacement-detection page", () =>
        replacementPage.close().catch(() => undefined),
      );
      replacementPage.on("pageerror", (error) => {
        replacementPageErrors.push(error.message);
      });
      await replacementPage.addInitScript(installWebSocketReadyStateProbeInPage);
      await replacementPage.goto(`${fixture.origin}/replace`, {
        waitUntil: "domcontentloaded",
      });
      try {
        await replacementPage.waitForFunction(
          () =>
            window.WebSocket ===
            window.__kcoderE2eWebSocketReadyStateProbe?.originalConstructor,
          undefined,
          { timeout: 5_000 },
        );
      } catch (error) {
        replacementDiagnostics = await replacementPage
          .evaluate(() => {
            const probe = window.__kcoderE2eWebSocketReadyStateProbe;
            return {
              probeInstalled: Boolean(probe?.installed),
              windowConstructorMatchesWrapper: Boolean(
                probe && window.WebSocket === probe.wrappedConstructor,
              ),
              windowConstructorMatchesOriginal: Boolean(
                probe && window.WebSocket === probe.originalConstructor,
              ),
              windowConstructorType: typeof window.WebSocket,
              originalConstructorType: typeof probe?.originalConstructor,
            };
          })
          .catch(() => null);
        throw error;
      }
      evidence.replacementDetection = await readWebSocketReadyStateProbe(
        replacementPage,
      );
      assert.equal(
        evidence.replacementDetection.windowConstructorMatchesWrapper,
        false,
        "the probe must detect an application replacing the constructor after an init-script wrapper",
      );
      assert.equal(evidence.replacementDetection.runtimeSocketCount, 0);
      await replacementPage.close();

      page = await browser.newPage({
        viewport: { width: 360, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      });
      context.addCleanup("close post-navigation route probe page", () =>
        page.close().catch(() => undefined),
      );
      await page.routeWebSocket(
        (url) => {
          routeEvidence.matchedUrl =
            `${url.protocol}//${url.host}${url.pathname}${url.search}`;
          return true;
        },
        (routedClientSocket) => {
          routeEvidence.routeCreated = true;
          const upstreamSocket = routedClientSocket.connectToServer();
          routeEvidence.upstreamSocketCreated = true;
          routedClientSocket.onMessage((message) => {
            routeEvidence.clientToUpstreamMessages += 1;
            upstreamSocket.send(message);
          });
          upstreamSocket.onMessage((message) => {
            routeEvidence.upstreamToClientMessages += 1;
            routedClientSocket.send(message);
          });
        },
      );
      await page.goto(`${fixture.origin}/probe`, {
        waitUntil: "domcontentloaded",
      });

      evidence.afterPostNavigationInstall =
        await installWebSocketReadyStateProbe(page);
      assert.equal(
        evidence.afterPostNavigationInstall.windowConstructorMatchesWrapper,
        true,
      );
      await page.getByTestId("connect").tap();
      await page.getByTestId("probe-status").getByText("connected").waitFor({
        state: "visible",
        timeout: 10_000,
      });

      const applicationObjectIsCapturedSocket = await page.evaluate(() => {
        const probe = window.__kcoderE2eWebSocketReadyStateProbe;
        return (
          probe?.runtimeSockets.length === 1 &&
          window.__readyStateProbeApplicationSocket === probe.runtimeSockets[0]
        );
      });
      assert.equal(
        applicationObjectIsCapturedSocket,
        true,
        "the wrapper must return the same WebSocket object used by the page's application",
      );
      evidence.afterConnect = await readWebSocketReadyStateProbe(page);
      assert.equal(evidence.afterConnect.windowConstructorMatchesWrapper, true);
      assert.equal(evidence.afterConnect.runtimeSocketCount, 1);
      assert.equal(evidence.afterConnect.sockets[0].unforcedReadyState, 1);
      assert.equal(evidence.afterConnect.sockets[0].effectiveReadyState, 1);
      assert.equal(fixture.stats.upgradeCount, 1);
      assert.equal(routeEvidence.routeCreated, true);
      assert.equal(routeEvidence.upstreamSocketCreated, true);

      const targetPrompt = "probe-target";
      await configureWebSocketReadyStateProbe(page, {
        targetPrompt,
        forceClosed: true,
        resetTargetSendCount: true,
      });
      const forcedBeforeInteraction = await readWebSocketReadyStateProbe(page);
      assert.equal(forcedBeforeInteraction.forceClosed, true);
      assert.equal(forcedBeforeInteraction.sockets[0].unforcedReadyState, 1);
      assert.equal(forcedBeforeInteraction.sockets[0].effectiveReadyState, 3);
      const appForcedReadsBefore =
        forcedBeforeInteraction.applicationForcedClosedReadyStateReads;

      await page.getByTestId("send").tap();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="probe-status"]')?.textContent === "not-sent:3",
        undefined,
        { timeout: 5_000 },
      );
      evidence.whileForcedClosed = await readWebSocketReadyStateProbe(page);
      evidence.fixture = snapshotFixture(fixture.stats);
      assert.ok(
        evidence.whileForcedClosed.applicationForcedClosedReadyStateReads >
          appForcedReadsBefore,
        "the page application must read the forced effective state; diagnostic getter calls are separately counted",
      );
      assert.equal(
        evidence.whileForcedClosed.targetTurnStartSendInvocations,
        0,
      );
      assert.equal(routeEvidence.clientToUpstreamMessages, 0);
      assert.equal(fixture.stats.turnStartFrames, 0);
      assert.equal(fixture.stats.acknowledgements, 0);

      await configureWebSocketReadyStateProbe(page, { forceClosed: false });
      const restored = await readWebSocketReadyStateProbe(page);
      assert.equal(restored.sockets[0].unforcedReadyState, 1);
      assert.equal(restored.sockets[0].effectiveReadyState, 1);
      await page.getByTestId("send").tap();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="probe-status"]')?.textContent === "ack",
        undefined,
        { timeout: 10_000 },
      );
      evidence.afterRestoreAndSend = await readWebSocketReadyStateProbe(page);
      evidence.fixture = snapshotFixture(fixture.stats);
      assert.equal(
        evidence.afterRestoreAndSend.targetTurnStartSendInvocations,
        1,
      );
      assert.equal(routeEvidence.clientToUpstreamMessages, 1);
      assert.equal(routeEvidence.upstreamToClientMessages, 1);
      assert.equal(fixture.stats.turnStartFrames, 1);
      assert.equal(fixture.stats.acknowledgements, 1);
      assert.deepEqual(fixture.stats.errors, []);
      await page.screenshot({
        path: context.pathInArtifacts("ready-state-probe-restored-ack.png"),
      });

      await context.writeArtifactJson("websocket-ready-state-probe.json", evidence);
    } catch (error) {
      failure = error;
      await context
        .writeArtifactJson("websocket-ready-state-probe-failure.json", {
          ...evidence,
          fixture: snapshotFixture(fixture.stats),
          replacementDiagnostics,
          replacementPageErrors,
          failure: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      if (page) {
        await page
          .screenshot({
            path: context.pathInArtifacts("websocket-ready-state-probe-failure.png"),
          })
          .catch(() => undefined);
      }
      if (replacementPage) {
        await replacementPage
          .screenshot({
            path: context.pathInArtifacts(
              "websocket-ready-state-probe-replacement-failure.png",
            ),
          })
          .catch(() => undefined);
      }
    }

    await context.finish(
      failure ? "failed" : "passed",
      {
        evidenceArtifact: failure
          ? "websocket-ready-state-probe-failure.json"
          : "websocket-ready-state-probe.json",
        noExpo: true,
        noGateway: true,
        noModel: true,
      },
      failure,
    );
    if (failure) throw failure;

    const manifest = JSON.parse(
      await readFile(`${context.runRoot}/manifest.json`, "utf8"),
    );
    assert.equal(manifest.status, "passed");
    assert.ok(manifest.cleanupSteps.every((step) => step.status === "completed"));
    assert.ok(manifest.processes.every((process) => process.stopped));
    await assert.rejects(access(context.stateDir));
  },
);

function createLoopbackHttpWebSocketFixture() {
  const stats = {
    upgradeCount: 0,
    turnStartFrames: 0,
    acknowledgements: 0,
    malformedFrames: 0,
    errors: [],
  };
  const sockets = new Set();
  let origin = null;
  let webSocketUrl = null;
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname === "/probe") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(probePageHtml(webSocketUrl, ""));
      return;
    }
    if (requestUrl.pathname === "/replace") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        probePageHtml(
          webSocketUrl,
          "window.WebSocket = window.__kcoderE2eWebSocketReadyStateProbe.originalConstructor;",
        ),
      );
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  });

  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/rpc?channel=runtime") {
      socket.destroy();
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );
    stats.upgradeCount += 1;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));

    let buffered = head.length ? Buffer.from(head) : Buffer.alloc(0);
    const consume = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        const first = buffered[0];
        const second = buffered[1];
        const opcode = first & 0x0f;
        const isMasked = Boolean(second & 0x80);
        let payloadLength = second & 0x7f;
        let offset = 2;
        if (payloadLength === 126) {
          if (buffered.length < offset + 2) return;
          payloadLength = buffered.readUInt16BE(offset);
          offset += 2;
        } else if (payloadLength === 127) {
          if (buffered.length < offset + 8) return;
          const length64 = buffered.readBigUInt64BE(offset);
          if (length64 > 4096n) {
            stats.errors.push("frame exceeded the 4096-byte fixture bound");
            socket.destroy();
            return;
          }
          payloadLength = Number(length64);
          offset += 8;
        }
        if (!isMasked) {
          stats.errors.push("browser WebSocket frame was unexpectedly unmasked");
          socket.destroy();
          return;
        }
        if (buffered.length < offset + 4 + payloadLength) return;
        const mask = buffered.subarray(offset, offset + 4);
        offset += 4;
        const payload = Buffer.from(buffered.subarray(offset, offset + payloadLength));
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
        buffered = buffered.subarray(offset + payloadLength);

        if (opcode === 8) {
          socket.end();
          return;
        }
        if (opcode === 9) {
          writeServerFrame(socket, payload, 10);
          continue;
        }
        if (opcode !== 1) {
          stats.errors.push("fixture received a non-text data frame");
          socket.destroy();
          return;
        }
        let message;
        try {
          message = JSON.parse(payload.toString("utf8"));
        } catch {
          stats.malformedFrames += 1;
          continue;
        }
        if (message.method === "turn/start") {
          stats.turnStartFrames += 1;
          stats.acknowledgements += 1;
          writeServerFrame(
            socket,
            Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { ok: true } })),
            1,
          );
        }
      }
    };
    socket.on("data", consume);
    if (head.length) consume(Buffer.alloc(0));
  });

  return {
    server,
    stats,
    get origin() {
      return origin;
    },
    get webSocketUrl() {
      return webSocketUrl;
    },
    setOrigin(nextOrigin) {
      origin = nextOrigin;
      webSocketUrl = `${origin.replace(/^http/, "ws")}/rpc?channel=runtime`;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function probePageHtml(webSocketUrl, afterProbeScript) {
  return `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body>
  <button data-testid="connect" type="button">Connect</button>
  <button data-testid="send" type="button">Send</button>
  <output data-testid="probe-status">idle</output>
  <script>
    window.__readyStateProbeApplicationSocket = null;
    window.__readyStateProbeApplicationStatus = "idle";
    const statusNode = document.querySelector('[data-testid="probe-status"]');
    const setStatus = (value) => {
      window.__readyStateProbeApplicationStatus = value;
      statusNode.textContent = value;
    };
    document.querySelector('[data-testid="connect"]').addEventListener('click', () => {
      const socket = new WebSocket(${JSON.stringify(webSocketUrl)});
      window.__readyStateProbeApplicationSocket = socket;
      socket.addEventListener('open', () => setStatus('connected'));
      socket.addEventListener('message', () => setStatus('ack'));
    });
    document.querySelector('[data-testid="send"]').addEventListener('click', () => {
      const socket = window.__readyStateProbeApplicationSocket;
      const state = socket?.readyState;
      if (!socket || state !== WebSocket.OPEN) {
        setStatus('not-sent:' + String(state));
        return;
      }
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'turn/start',
        params: { input: ['probe-target'] },
      }));
      setStatus('sent');
    });
    ${afterProbeScript}
  </script>
</body></html>`;
}

function writeServerFrame(socket, payload, opcode) {
  const body = Buffer.from(payload);
  if (body.length >= 126) {
    socket.destroy();
    return;
  }
  socket.write(Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]));
}

async function listenLoopback(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function snapshotFixture(stats) {
  return {
    upgradeCount: stats.upgradeCount,
    turnStartFrames: stats.turnStartFrames,
    acknowledgements: stats.acknowledgements,
    malformedFrames: stats.malformedFrames,
    errors: [...stats.errors],
  };
}
