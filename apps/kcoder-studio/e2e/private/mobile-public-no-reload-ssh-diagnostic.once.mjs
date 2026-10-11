import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath, rm } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { repoRoot, runE2E } from "../harness/run-context.mjs";

const pinnedNode = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const pinnedNodeSha256 = "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9";
const remotePython = String.raw`
import hashlib, json, subprocess, sys, time

def phase(name, **fields):
    row = {"phase": name, **fields}
    print("READONLY_PHASE " + json.dumps(row, separators=(",", ":")), file=sys.stderr, flush=True)

def run_probe(name, args):
    phase(name + "_begin")
    started = time.monotonic_ns()
    try:
        result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=4)
        duration_ms = (time.monotonic_ns() - started) / 1000000
        phase(name + "_end", exitCode=result.returncode, durationMs=round(duration_ms, 3),
              stdoutBytes=len(result.stdout.encode()), stderrBytes=len(result.stderr.encode()), timedOut=False)
        if name == "caddy_process":
            fields = result.stdout.strip().split(None, 3)
            return {"exitCode": result.returncode, "durationMs": round(duration_ms, 3),
                    "euid": int(fields[2]) if len(fields) >= 3 else None,
                    "comm": fields[3] if len(fields) >= 4 else None,
                    "expectedPidVisible": bool(fields and fields[0] == str(EXPECTED_PID))}
        pids = sorted({int(value) for value in __import__("re").findall(r"pid=(\d+)", result.stdout)})
        return {"exitCode": result.returncode, "durationMs": round(duration_ms, 3),
                "stdoutBytes": len(result.stdout.encode()), "stderrBytes": len(result.stderr.encode()),
                "ownerPids": pids}
    except subprocess.TimeoutExpired:
        duration_ms = (time.monotonic_ns() - started) / 1000000
        phase(name + "_timeout", durationMs=round(duration_ms, 3), boundMs=4000)
        return {"exitCode": None, "durationMs": round(duration_ms, 3), "timedOut": True}

try:
    phase("remote_python_started")
    payload = sys.stdin.buffer.read()
    phase("request_stdin_eof", bytes=len(payload), eof=True)
    request = json.loads(payload.decode("utf-8"))
    phase("request_parsed", noncePresent=isinstance(request.get("nonce"), str))
    EXPECTED_PID = 255620
    nonce_sha256 = hashlib.sha256(payload).hexdigest()
    commands = {
        "caddy_process": run_probe("caddy_process", ["sudo", "-n", "ps", "-p", str(EXPECTED_PID), "-o", "pid=,ppid=,euid=,comm="]),
        "listeners_443": run_probe("listeners_443", ["sudo", "-n", "ss", "-H", "-ltnp", "sport = :443"]),
        "forward_32552": run_probe("forward_32552", ["sudo", "-n", "ss", "-H", "-ltnp", "sport = :32552"]),
    }
    response = {"ok": True, "requestBytesSha256": nonce_sha256, "commands": commands,
                "remoteActionsReadOnly": True, "noStaticTreeWalk": True}
    phase("remote_response_ready", commandCount=len(commands))
    print(json.dumps(response, separators=(",", ":")), flush=True)
except Exception as exc:
    phase("remote_python_error", errorType=type(exc).__name__)
    print(json.dumps({"ok": False, "errorType": type(exc).__name__}, separators=(",", ":")), flush=True)
    sys.exit(2)
`;

await runE2E(import.meta.url, {
  testId: "mobile-public-no-reload-ssh-stage-diagnostic-once",
  tier: "manual-live",
  modelPolicy: "no model; bounded read-only SSH diagnostics only, no service or static-root mutations",
  cleanupTimeoutMs: 60_000,
  processSignalTimeoutMs: 5_000,
}, async context => {
  assert.equal(process.version, "v22.17.0");
  assert.equal(await realpath(process.execPath), await realpath(pinnedNode));
  assert.equal(sha256(await readFile(process.execPath)), pinnedNodeSha256);
  context.registerSecret(context.seed);

  const requestBytes = Buffer.from(JSON.stringify({ nonce: context.seed }));
  const requestBytesSha256 = sha256(requestBytes);
  const debugPath = context.pathInState("ssh-client-debug.log");
  const debugFile = await open(debugPath, "wx", 0o600);
  await debugFile.close();
  const child = context.spawnOwned("readonly-ssh-stage-diagnostic", "ssh", [
    "-T", "-v", "-E", debugPath,
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ConnectionAttempts=1",
    "aliyun",
    `python3 -c 'import base64;exec(base64.b64decode("${Buffer.from(remotePython).toString("base64")}"))'`,
  ], {
    cwd: repoRoot,
    env: context.isolatedEnvironment({}, ["SSH_AUTH_SOCK"]),
    stdin: "pipe",
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on("data", chunk => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= 64 * 1024) stdoutChunks.push(Buffer.from(chunk));
  });
  child.stderr.on("data", chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes <= 64 * 1024) stderrChunks.push(Buffer.from(chunk));
  });
  let spawnError = null;
  child.once("error", error => { spawnError = error.message; });
  const childClosed = new Promise(resolveClose => {
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  child.stdin.end(requestBytes);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void context.stopOwned("readonly-ssh-stage-diagnostic").catch(() => undefined);
  }, 35_000);
  let exit;
  try {
    exit = await childClosed;
  } finally {
    clearTimeout(timer);
  }

  const debugText = await readFile(debugPath, "utf8").catch(() => "");
  const remotePhaseText = Buffer.concat(stderrChunks).toString("utf8");
  const sshStages = classifyOpenSshStages(debugText);
  const remotePhases = parseRemotePhases(remotePhaseText);
  await rm(debugPath, { force: true });
  let envelope;
  try {
    envelope = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8").trim());
  } catch {
    envelope = { ok: false, errorType: "NoStructuredRemoteResponse" };
  }
  const summary = {
    sourceContract: {
      spawnedWithStdinPipe: true,
      requestEndedWithEof: true,
      remoteProgramReadsStdinToEof: true,
      sudoRunsWithStdinDevNullAndNoPrompt: true,
      requestBytesSha256,
    },
    sshDebugLog: {
      capturedToRunState0600: true,
      rawDebugPersistedToArtifact: false,
      classifiedStages: sshStages,
    },
    remotePhaseMarkers: remotePhases,
    child: { pid: child.pid, exitCode: exit.code, signal: exit.signal, timedOut, spawnError, stdoutBytes, stderrBytes },
    remote: envelope.ok ? envelope : { ok: false, errorType: envelope.errorType },
    noBrowserStarted: true,
    noRelayOrGatewayStarted: true,
    noCaddyReloadOrSignal: true,
    noStaticRootExchangeOrDelete: true,
    noProductionRelayPortTouched: true,
  };
  await context.writeArtifactJson("readonly-ssh-stage-diagnostic.json", summary);
  assert.equal(timedOut, false, "the diagnostic SSH must finish inside its single 35-second bound");
  assert.equal(exit.signal, null);
  assert.equal(exit.code, 0, "the diagnostic SSH must return successfully");
  assert.equal(envelope.ok, true, "the remote Python diagnostic must return a structured result");
  assert.equal(envelope.requestBytesSha256, requestBytesSha256, "the remote process must read the complete request through EOF");
  return summary;
});

function classifyOpenSshStages(text) {
  const patterns = {
    connectionAttemptStarted: /debug1: Connecting to .* port \d+\./,
    tcpConnectionEstablished: /debug1: Connection established\./,
    authenticationStarted: /debug1: Authenticating to .* as /,
    authenticationSucceeded: /debug1: Authenticated to .* using "/,
    remoteCommandSent: /debug1: Sending command:/,
    remoteExitStatusSeen: /debug1: Exit status \d+/,
  };
  const lines = text.split(/\r?\n/);
  return Object.fromEntries(Object.entries(patterns).map(([name, pattern]) => [name, lines.some(line => pattern.test(line))]));
}

function parseRemotePhases(text) {
  const phases = [];
  for (const line of text.split(/\r?\n/)) {
    const marker = line.indexOf("READONLY_PHASE ");
    if (marker < 0) continue;
    try {
      const row = JSON.parse(line.slice(marker + "READONLY_PHASE ".length));
      if (typeof row.phase === "string" && /^[a-z0-9_]+$/.test(row.phase)) phases.push(row);
    } catch {
      phases.push({ phase: "unparsed-marker" });
    }
  }
  return phases;
}

async function readRegularFile(path) {
  const normalized = resolve(path);
  const boundary = resolve(repoRoot, "target/test/apps/kcoder-studio/e2e");
  const canonicalBoundary = await realpath(boundary);
  const rel = relative(canonicalBoundary, normalized);
  assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`));
  const info = await lstat(normalized);
  assert.ok(info.isFile() && !info.isSymbolicLink());
  assert.equal(await realpath(normalized), normalized);
  return readFile(normalized);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
