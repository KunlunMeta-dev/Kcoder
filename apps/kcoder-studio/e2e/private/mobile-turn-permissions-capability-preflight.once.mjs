import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startGateway, waitForGatewayRpcToken } from "../harness/gateway.mjs";
import {
  closeRpcAndWait,
  gatewayRpcUrl,
  initializeRpc,
  openRpc,
} from "../harness/rpc.mjs";
import {
  findOwnedExecutableProcesses,
  hashExecutableFile,
} from "../harness/owned-executable-provenance.mjs";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";

const configuredBinary = resolve(
  process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/release/kcoder"),
);

await runE2E(
  import.meta.url,
  {
    testId: "mobile-turn-permissions-initialize-only-preflight",
    tier: "full-integration",
    modelPolicy:
      "initialize-only local app-server capability probe; no thread, turn, Provider, or model request",
    retainSuccessLogs: true,
  },
  async (context) => {
    const configuredBefore = await hashExecutableFile(configuredBinary);
    const ownedBinDir = context.pathInState("bin");
    await mkdir(ownedBinDir, { recursive: true, mode: 0o700 });
    const ownedBinary = resolve(ownedBinDir, "kcoder");
    await copyFile(configuredBinary, ownedBinary);
    await chmod(ownedBinary, 0o700);
    const [configuredAfterCopy, ownedBefore] = await Promise.all([
      hashExecutableFile(configuredBinary),
      hashExecutableFile(ownedBinary),
    ]);
    assert.equal(configuredAfterCopy.sha256, configuredBefore.sha256);
    assert.equal(ownedBefore.sha256, configuredBefore.sha256);

    const workspace = context.pathInState("workspace");
    const configDir = context.pathInState("config");
    const webRoot = context.pathInState("web-root");
    await Promise.all([
      mkdir(workspace, { recursive: true, mode: 0o700 }),
      mkdir(configDir, { recursive: true, mode: 0o700 }),
      mkdir(webRoot, { recursive: true, mode: 0o700 }),
    ]);
    await context.writeStateJson("config/settings.json", { hooks: {} });
    await context.writeStateJson("config/credentials.json", {});
    await writeFile(
      resolve(webRoot, "index.html"),
      "<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>\n",
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    const settingsFile = resolve(configDir, "settings.json");
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "local",
        label: "Initialize-only capability probe",
        runtime: "kcoder",
        transport: "local",
        command: ownedBinary,
        workspace,
        settingsFile,
      },
    ]);
    const gatewayLabel = "mobile-turn-permissions-probe-gateway";
    const gateway = await startGateway(context, {
      label: gatewayLabel,
      workspace,
      serversFile,
      kcoderBin: ownedBinary,
      env: {
        KCODER_CONFIG_DIR: configDir,
        KCODER_STUDIO_WEB_ROOT: webRoot,
        KCODER_TRAINING_MODE: "true",
      },
    });
    const rpcToken = await waitForGatewayRpcToken(context, gateway);
    const rpc = await openRpc(gatewayRpcUrl(gateway, "local", rpcToken));
    context.addCleanup("close initialize-only capability RPC", () =>
      closeRpcAndWait(rpc, "initialize-only capability RPC"),
    );

    const initialized = await initializeRpc(
      rpc,
      "mobile-turn-permissions-capability-preflight",
    );
    const experimental = initialized.capabilities?.experimental ?? {};
    const turnPermissions = experimental.turnPermissions === true;
    const gatewayProcessGroupId =
      context.processes.get(gatewayLabel)?.pgid ?? gateway.child.pid;
    const ownedProcesses = await waitFor(
      async () => {
        const matches = await findOwnedExecutableProcesses({
          pgid: gatewayProcessGroupId,
          executablePath: ownedBinary,
        });
        return matches.length ? matches : null;
      },
      10_000,
      "owned app-server binary after initialize",
      50,
      context.abortSignal,
    );
    const [ownedAfter, configuredAfter] = await Promise.all([
      hashExecutableFile(ownedBinary),
      hashExecutableFile(configuredBinary),
    ]);
    assert.equal(ownedAfter.sha256, ownedBefore.sha256);
    assert.equal(configuredAfter.sha256, configuredBefore.sha256);
    assert.ok(
      ownedProcesses.some((process) => process.sha256 === ownedBefore.sha256),
      "the initialized Gateway must run the exact owned app-server copy",
    );

    const evidence = {
      gitCommit: context.gitCommit,
      sourceBinding: "UNVERIFIED",
      requestMethods: ["initialize"],
      modelOrProviderRequest: false,
      serverInfo: initialized.serverInfo ?? null,
      turnPermissions,
      binary: {
        configuredPath: configuredBefore.path,
        configuredSha256: configuredBefore.sha256,
        configuredMtime: configuredBefore.mtime,
        ownedPathRelativeToRun: "state/bin/kcoder",
        ownedSha256: ownedBefore.sha256,
        processGroupId: gatewayProcessGroupId,
        ownedProcesses,
        configuredFileUnchanged: configuredAfter.sha256 === configuredBefore.sha256,
      },
    };
    await context.writeArtifactJson("initialize-capability.json", evidence);
    return evidence;
  },
);
