import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { buildStopAndWaitForOriginalSidecarProgram, parseStopAndWaitForOriginalSidecarReceipt,
  stopAndWaitForOriginalSidecarOnce } from "./single-ssh-sidecar-stop-wait.mjs";

const ORIGINAL = Object.freeze({ pid: 777, configPath: "/tmp/kc-phone-ux-443-20261007-183008/isolated-443-front.Caddyfile",
  configSha256: "520ba15051f238e695aee48833b8f1ab7ca3e2eed3e1b1347b18a20e8018ac7c" });
const OBSERVED = Object.freeze({ pid: 777, exeMatches: true, euid: 0, argvConfigMatch: true, configSha256: ORIGINAL.configSha256 });
const OPTIONS = Object.freeze({ repoRoot: "/fixture/repo" });

function generatedRun(scenario = {}) {
  const source = buildStopAndWaitForOriginalSidecarProgram(ORIGINAL, OBSERVED);
  const harness = String.raw`import ast,json,signal,sys
record=json.load(sys.stdin); compile(record['source'],'generated-stop-wait','exec')
module=ast.parse(record['source']); selected=[node for node in module.body if isinstance(node,ast.FunctionDef) and node.name=='run_transition']
assert len(selected)==1
events=[]; payload=record['payload']; original=payload['original']; scenario=record['scenario']
expected_argv=[part.encode() for part in original['argv']]
class Ops:
 def config_sha(self,path): events.append(['config-sha',path]); return original['configSha256']
 def listener_text(self,port):
  events.append(['listener',port])
  index=sum(1 for row in events if row[0]=='listener')-1
  if index==0 or index==1: return 'users:(("caddy",pid=777,fd=8))\\n'
  return scenario.get('afterExitListener','')
 def listener_pids(self,text):
  if 'pid=777,' in text: return [777]
  if 'pid=889,' in text: return [889]
  return []
 def pidfd_open(self,pid,flags): events.append(['pidfd-open',pid,flags]); return 41
 def pidfd_exited(self,fd): events.append(['pidfd-poll-zero',fd]); return False
 def read_identity(self,pid):
  events.append(['identity',pid])
  return {'pid':pid,'startTicks':991,'exe':scenario.get('exe','/usr/bin/caddy'),'exeDev':2049,'exeIno':1771,
    'argv':scenario.get('argv',expected_argv),'argvSha256':'a'*64,'euid':scenario.get('euid',0)}
 def pidfd_send_signal(self,fd,sig,info,flags): events.append(['pidfd-signal',fd,int(sig),info,flags])
 def wait_pidfd(self,fd,timeout): events.append(['pidfd-wait',fd,timeout]); return scenario.get('exited',True)
 def pidfd_close(self,fd): events.append(['pidfd-close',fd])
ns={'signal':signal}
exec(compile(ast.Module(body=selected,type_ignores=[]),'actual-generated-stop-wait','exec'),ns)
try: result={'ok':True,'receipt':ns['run_transition'](payload,Ops())}
except Exception as error: result={'ok':False,'error':str(error)}
result['events']=events
print(json.dumps(result,separators=(',',':')))`;
  const result = spawnSync("python3", ["-c", harness], { input: JSON.stringify({ source, payload: payloadFromSource(source), scenario }),
    encoding: "utf8", timeout: 5_000, maxBuffer: 32 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return { source, ...JSON.parse(result.stdout) };
}

// The generated program embeds this exact JSON as p; extracting it avoids a
// second hand-written Python payload in the test.
function payloadFromSource(source) {
  const match = /^p=json\.loads\((.+)\)$/m.exec(source);
  assert.ok(match, "generated Python must contain the immutable input payload");
  const encodedJson = JSON.parse(match[1]);
  return JSON.parse(encodedJson);
}

function eventsFor(result, kind) { return result.events.filter(row => row[0] === kind); }

test("generated Python compiles and the single SSH wrapper sends one stdin program", async () => {
  const source = buildStopAndWaitForOriginalSidecarProgram(ORIGINAL, OBSERVED);
  assert.doesNotMatch(source, /\bssh\b|Popen\s*\(/i, "remote program must only stop/wait/free; candidate launch stays later");
  const receipt = { state: "original-exited-443-free", pid: ORIGINAL.pid, startTicks: 991,
    startTicksSource: "observed-after-pidfd-open", exe: "/usr/bin/caddy", exeDev: 2049, exeIno: 1771, euid: 0,
    argvSha256: "a".repeat(64), configSha256: ORIGINAL.configSha256, pidfd: true, termSent: true,
    exitConfirmed: true, exitWaitMs: 10_000, port443Free: true };
  const calls = [], child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null;
  child.stdin.on("finish", () => {
    child.stderr.write("KCUX_STAGE:REMOTE_PYTHON_ENTERED\nKCUX_STAGE:REMOTE_PROGRAM_COMPLETE\n");
    child.stdout.end(JSON.stringify(receipt)); child.stderr.end(); child.exitCode = 0; child.emit("close", 0, null);
  });
  const context = { spawnOwned() { throw new Error("direct SSH spawn is forbidden"); },
    isolatedEnvironment: () => ({}), stopOwned: async () => { throw new Error("unexpected stop"); } };
  const sshTransport = { async spawnManaged(label, command, spawnOptions) {
      calls.push({ label, command, spawnOptions }); return child;
    } };
  const waitFor = async predicate => {
    const end = Date.now() + 1000;
    while (Date.now() < end) { if (predicate()) return true; await new Promise(resolve => setTimeout(resolve, 1)); }
    throw new Error("fake child did not close");
  };
  const result = await stopAndWaitForOriginalSidecarOnce(context, ORIGINAL, OBSERVED,
    { sshTransport, ...OPTIONS, waitFor });
  assert.equal(result.state, "original-exited-443-free");
  assert.equal(calls.length, 1, "the owned managed transport is used exactly once");
  assert.equal(calls[0].label, "ssh-single-connection-stop-original-sidecar");
  assert.equal(calls[0].command, "sudo -n python3 -");
  assert.equal(calls[0].spawnOptions.cwd, OPTIONS.repoRoot);
  assert.equal(calls[0].spawnOptions.stdin, "pipe");
});

test("generated Python TERM waits on the same pidfd and ACKs only after 443 is free", () => {
  const result = generatedRun();
  assert.equal(result.ok, true, JSON.stringify(result.events));
  assert.equal(result.receipt.state, "original-exited-443-free");
  assert.equal(result.receipt.startTicks, 991);
  assert.equal(result.receipt.startTicksSource, "observed-after-pidfd-open");
  assert.equal(result.receipt.exitWaitMs, 10_000); assert.equal(result.receipt.port443Free, true);
  assert.deepEqual(eventsFor(result, "pidfd-signal"), [["pidfd-signal", 41, 0, null, 0], ["pidfd-signal", 41, 15, null, 0]]);
  assert.deepEqual(eventsFor(result, "pidfd-wait"), [["pidfd-wait", 41, 10_000]]);
  assert.deepEqual(eventsFor(result, "listener").map(row => row[1]), [443, 443, 443]);
  assert.equal(eventsFor(result, "pidfd-close").length, 1);
  assert.ok(result.events.findIndex(row => row[0] === "pidfd-wait") < result.events.findLastIndex(row => row[0] === "listener"));
});

test("generated Python refuses identity mismatch before TERM", () => {
  const result = generatedRun({ euid: 1000 });
  assert.equal(result.ok, false); assert.equal(result.error, "original-process-identity-mismatch");
  assert.equal(eventsFor(result, "pidfd-signal").length, 0);
  assert.deepEqual(eventsFor(result, "pidfd-close"), [["pidfd-close", 41]]);
});

test("generated Python leaves a TERM timeout bounded and never SIGKILLs or launches candidate", () => {
  const result = generatedRun({ exited: false });
  assert.equal(result.ok, false); assert.equal(result.error, "original-term-exit-timeout");
  assert.deepEqual(eventsFor(result, "pidfd-signal").map(row => row[2]), [0, 15]);
  assert.deepEqual(eventsFor(result, "pidfd-wait"), [["pidfd-wait", 41, 10_000]]);
  assert.equal(eventsFor(result, "listener").length, 2, "no post-exit listener check or candidate launch after timeout");
});

test("generated Python refuses an unknown 443 listener after original exits", () => {
  const result = generatedRun({ afterExitListener: 'users:(("unknown",pid=889,fd=7))\\n' });
  assert.equal(result.ok, false); assert.equal(result.error, "unknown-443-listener-after-original-exit");
  assert.deepEqual(eventsFor(result, "pidfd-signal").map(row => row[2]), [0, 15]);
  assert.deepEqual(eventsFor(result, "pidfd-wait"), [["pidfd-wait", 41, 10_000]]);
  assert.equal(eventsFor(result, "pidfd-close").length, 1);
  assert.doesNotMatch(result.source, /Popen\s*\(/);
});

test("identity, exit-timeout and unknown-listener failures do not retry SSH", async () => {
  for (const scenario of [{ euid: 1000 }, { exited: false },
    { afterExitListener: 'users:(("unknown",pid=889,fd=7))\\n' }]) {
    const generated = generatedRun(scenario);
    assert.equal(generated.ok, false);
    let spawnCount = 0, stopCount = 0;
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null;
    child.stdin.on("finish", () => {
      child.stdout.end(JSON.stringify({ state: "failed", reason: generated.error }));
      child.exitCode = 1; child.emit("close", 1, null);
    });
    const context = { spawnOwned() { throw new Error("direct SSH fallback is forbidden"); }, isolatedEnvironment: () => ({}),
      stopOwned: async () => { stopCount++; }, writeArtifactJson: async () => {}, redactText: value => value };
    const sshTransport = { async spawnManaged() { spawnCount++; return child; } };
    const waitFor = async predicate => {
      const end = Date.now() + 1000;
      while (Date.now() < end) { if (predicate()) return true; await new Promise(resolve => setTimeout(resolve, 1)); }
      throw new Error("fake child did not close");
    };
    await assert.rejects(stopAndWaitForOriginalSidecarOnce(context, ORIGINAL, OBSERVED,
      { sshTransport, ...OPTIONS, waitFor }));
    assert.equal(spawnCount, 1); assert.equal(stopCount, 0);
  }
});

test("receipt parser refuses missing or contradictory free-port proof", () => {
  const valid = { state: "original-exited-443-free", pid: ORIGINAL.pid, startTicks: 991,
    startTicksSource: "observed-after-pidfd-open", exe: "/usr/bin/caddy", exeDev: 2049, exeIno: 1771, euid: 0,
    argvSha256: "a".repeat(64), configSha256: ORIGINAL.configSha256, pidfd: true, termSent: true,
    exitConfirmed: true, exitWaitMs: 10_000, port443Free: true };
  assert.deepEqual(parseStopAndWaitForOriginalSidecarReceipt(JSON.stringify(valid), ORIGINAL), valid);
  assert.throws(() => parseStopAndWaitForOriginalSidecarReceipt(JSON.stringify({ ...valid, port443Free: false }), ORIGINAL));
});
