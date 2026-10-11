import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { appRoot, runE2E } from "./run-context.mjs";

const mobileRoot = resolve(appRoot, "mobile");
const rpcSourcePath = resolve(mobileRoot, "src/gateway/rpc.ts");
const requireMobile = createRequire(resolve(mobileRoot, "package.json"));
const requireRpc = createRequire(rpcSourcePath);

function loadExpoAndroidRpcModule(
  source,
  { setTimer = setTimeout, clearTimer = clearTimeout } = {},
) {
  const { transformFromAstSync } = requireMobile("@babel/core");
  const { getDefaultConfig } = requireMobile("expo/metro-config");
  const metro = getDefaultConfig(mobileRoot);
  const transformer = requireMobile(metro.transformer.babelTransformerPath);
  const transformed = transformer.transform({
    filename: rpcSourcePath,
    src: source,
    options: {
      projectRoot: mobileRoot,
      platform: "android",
      dev: false,
      type: "module",
      customTransformOptions: { engine: "hermes", routerRoot: "app" },
      enableBabelRCLookup: true,
      experimentalImportSupport: true,
    },
  });
  const commonJs = transformFromAstSync(transformed.ast, undefined, {
    configFile: false,
    babelrc: false,
    plugins: [
      requireMobile.resolve("@babel/plugin-transform-modules-commonjs"),
    ],
  });
  if (!commonJs?.code)
    throw new Error("Expo Android Babel emitted no rpc.ts module code");

  const module = { exports: {} };
  const gatewayConnectionBudget = {
    run: (operation) => operation(),
  };
  const moduleRequire = (specifier) => {
    if (specifier === "react-native") return { Platform: { OS: "android" } };
    if (specifier.includes("gatewayConnectionBudget"))
      return { gatewayConnectionBudget };
    if (specifier === "./http") {
      // This probe exercises already-connected request/send error semantics.
      // Authentication is outside its scope and must never be bypassed silently.
      return { ensureGatewayAuthorization() { throw new Error("unexpected authentication in RPC-send-only Babel probe"); } };
    }
    if (specifier.startsWith(".")) return requireRpc(specifier);
    return requireMobile(specifier);
  };
  class WebSocketStub {}
  WebSocketStub.OPEN = 1;

  vm.runInNewContext(
    `${commonJs.code}
module.exports.__nativeRpcAudit = { MobileRpcError, GatewayRpcClient };`,
    {
      module,
      exports: module.exports,
      require: moduleRequire,
      WebSocket: WebSocketStub,
      Error,
      setTimeout: setTimer,
      clearTimeout: clearTimer,
      __DEV__: false,
    },
  );
  return {
    ...module.exports.__nativeRpcAudit,
    WebSocketStub,
    transformedCode: commonJs.code,
  };
}

test(
  "Expo Android Babel preserves MobileRpcError delivery and real GatewayRpcClient request/send flow",
  async () => {
    await runE2E(
      import.meta.url,
      {
        testId: "mobile-rpc-native-babel-delivery-classification",
        modelIndependentBoundary:
          "Expo Android Babel lowering and local JSON-RPC socket-send error classification",
      },
      async (context) => {
        const source = await readFile(rpcSourcePath, "utf8");
        const sourceSha256 = createHash("sha256").update(source).digest("hex");
        const timerDelays = [];
        const activeTimers = new Set();
        let nextTimerId = 1;
        const fakeSetTimeout = (_callback, delayMs) => {
          const timer = { id: nextTimerId++ };
          timerDelays.push(delayMs);
          activeTimers.add(timer);
          return timer;
        };
        const fakeClearTimeout = (timer) => activeTimers.delete(timer);
        const {
          MobileRpcError,
          GatewayRpcClient,
          WebSocketStub,
          transformedCode,
        } = loadExpoAndroidRpcModule(source, {
          setTimer: fakeSetTimeout,
          clearTimer: fakeClearTimeout,
        });
        const transformedModuleSha256 = createHash("sha256")
          .update(transformedCode)
          .digest("hex");

        const defaultError = new MobileRpcError("default");
        assert.equal(defaultError.code, -1);
        assert.equal(defaultError.reason, "transport");
        assert.equal(defaultError.delivery, "unknown");

        const explicitDelivery = new MobileRpcError(
          "explicit",
          17,
          "protocol",
          "not-sent",
        );
        assert.equal(explicitDelivery.code, 17);
        assert.equal(explicitDelivery.reason, "protocol");
        assert.equal(explicitDelivery.delivery, "not-sent");

        const remoteDefault = new MobileRpcError("remote", -32047, "remote");
        assert.equal(remoteDefault.code, -32047);
        assert.equal(remoteDefault.reason, "remote");
        assert.equal(remoteDefault.delivery, "unknown");

        // The actual class constructor initializes the request and socket state.
        const preflightClient = new GatewayRpcClient({}, {});
        preflightClient.socket = null;
        await assert.rejects(
          preflightClient.request(
            "thread/list",
            { limit: 3 },
            1101,
          ),
          (error) => {
            assert.equal(error instanceof MobileRpcError, true);
            assert.equal(error.code, -1);
            assert.equal(error.reason, "transport");
            assert.equal(error.delivery, "not-sent");
            return true;
          },
        );
        assert.equal(preflightClient.pending.size, 0);

        const sentFrames = [];
        const connectedClient = new GatewayRpcClient({}, {});
        connectedClient.socket = {
          readyState: WebSocketStub.OPEN,
          send(serialized) {
            sentFrames.push(JSON.parse(serialized));
          },
        };
        const responsePromise = connectedClient.request(
          "thread/read",
          { threadId: "thread-native-babel", limit: 19 },
          2233,
        );
        assert.deepEqual(sentFrames, [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "thread/read",
            params: { threadId: "thread-native-babel", limit: 19 },
          },
        ]);
        connectedClient.handleMessage(
          JSON.stringify({ id: 1, result: "native-babel-ack" }),
        );
        assert.equal(await responsePromise, "native-babel-ack");
        assert.equal(connectedClient.pending.size, 0);

        const attemptedFrames = [];
        const throwingClient = new GatewayRpcClient({}, {});
        throwingClient.socket = {
          readyState: WebSocketStub.OPEN,
          send(serialized) {
            attemptedFrames.push(JSON.parse(serialized));
            throw new Error("native socket write rejected");
          },
        };
        await assert.rejects(
          throwingClient.request(
            "turn/start",
            {
              threadId: "thread-native-babel",
              input: [{ type: "text", text: "send once" }],
            },
            3344,
          ),
          (error) => {
            assert.equal(error instanceof MobileRpcError, true);
            assert.equal(error.message, "native socket write rejected");
            assert.equal(error.code, -1);
            assert.equal(error.reason, "transport");
            assert.equal(error.delivery, "unknown");
            return true;
          },
        );
        assert.deepEqual(attemptedFrames, [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "turn/start",
            params: {
              threadId: "thread-native-babel",
              input: [{ type: "text", text: "send once" }],
            },
          },
        ]);
        assert.equal(throwingClient.pending.size, 0);
        assert.deepEqual(timerDelays, [1101, 2233, 3344]);
        assert.equal(activeTimers.size, 0);

        const evidence = {
          result: "PASS_EXPO_ANDROID_BABEL_NODE_VM",
          platform: "android",
          transformedModule: "complete rpc.ts module; only react-native and unused gatewayConnectionBudget import are stubbed",
          rpcSourceSha256: sourceSha256,
          transformedCommonJsSha256: transformedModuleSha256,
          assertions: {
            defaultDelivery: defaultError.delivery,
            explicitFourthConstructorArgument: explicitDelivery.delivery,
            remoteErrorDefaultDelivery: remoteDefault.delivery,
            unopenedSocketDelivery: "not-sent",
            openSocketSendThrowDelivery: "unknown",
            successfulRequestFrame: sentFrames[0],
            attemptedRequestFrameBeforeSocketThrow: attemptedFrames[0],
            timeoutArgumentsMs: timerDelays,
            pendingRequestsCleared: true,
            timersCleared: true,
          },
          limits: {
            apkBuild: "NOT RUN",
            deviceRuntime: "UNVERIFIED",
            networkOrGateway: "NOT USED",
          },
        };
        await context.writeArtifactJson(
          "mobile-rpc-native-babel.json",
          evidence,
        );
        return evidence;
      },
    );
  },
);
