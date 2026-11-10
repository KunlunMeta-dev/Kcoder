import assert from "node:assert/strict";
import test from "node:test";
import {
  nativeSearchSettings,
  parseNativeWorkerInput,
  validateNativePermissionDefaults,
  nativeToolCallObservations,
  nativeSearchCapabilities,
  requireNativeSearchGates,
  validateNativeSearchReceipt,
  validateNativeFetchReceipt,
  NATIVE_FIRST_SEARCH_CALL,
  NATIVE_FIRST_FETCH_CALL,
  NATIVE_FIRST_FETCH_URL,
  controlledPacNativeCase,
  nativeApprovalResponse,
  NATIVE_BUNDLED_SEARCH_CALL,
} from "./windows-native-web-search.mjs";

test('controlled PAC case fixes one Bing marker and three expected native summary URLs',()=>{
 const value=controlledPacNativeCase('11111111-2222-3333-4444-555555555555');
 assert.equal(value.nativeQuery,'!bing KCODEROWNEDPAC11111111222233334444555555555555');
 assert.equal(value.expectedSources.length,3);assert.ok(value.expectedSources.every(url=>url.startsWith('https://example.com/kcoder-owned-pac-'+value.fixtureId+'/source-')));
 assert.throws(()=>controlledPacNativeCase('arbitrary query'));
 const frame={method:'approval/request',params:{threadId:'thread',turnId:'turn',approvalId:'approval',appServerEpoch:'epoch',toolCallId:NATIVE_BUNDLED_SEARCH_CALL,action:{type:'tool',name:'WebSearch',input:{query:value.nativeQuery,num_results:3}}}};
 assert.equal(nativeApprovalResponse(frame,'thread','turn','bundled-parent-route',value).decision,'accept');
 assert.throws(()=>nativeApprovalResponse(frame,'thread','turn','default',value));
 assert.throws(()=>nativeApprovalResponse(frame,'thread','turn','bundled-parent-route',{...value,nativeQuery:'different'}));
});
import {
  validateInstalledNativeSearchMode,
  validateInstalledNativeSearchResult,
  windowsInstallerFixtureParent,
} from "./windows-installer-lifecycle.mjs";

test("native installed search writes only a credential-free model connection", () => {
  const settings = nativeSearchSettings("http://127.0.0.1:1/v1");
  assert.equal(Object.hasOwn(settings, "web"), false);
  assert.equal(Object.hasOwn(settings, "mcp_servers"), false);
  assert.equal(settings.providers.ownedNativeModel.authentication.mode, "none");
  assert.equal(
    settings.providers.ownedNativeModel.context_window_tokens,
    128000,
  );
});
test("native approvals negotiate current typed identity capabilities", () => {
  assert.deepEqual(nativeSearchCapabilities(), {experimental: {
    studioWorkModesV1: true, approvalToolCallIdentityV1: true, interactionBindingV1: true,
  }});
});
test("native and external gates are independent and both required", () => {
  requireNativeSearchGates("1", "1");
  for (const [a, b] of [
    [undefined, "1"],
    ["1", undefined],
    ["0", "1"],
    ["1", "0"],
  ])
    assert.throws(() => requireNativeSearchGates(a, b));
  const options = {
    nativeWebSearch: true,
    nativeConsent: "1",
    externalConsent: "1",
    newInstaller: "/owned/new.exe",
    node: "D:\\node\\node.exe",
  };
  assert.equal(validateInstalledNativeSearchMode(options), true);
  assert.equal(windowsInstallerFixtureParent(options), "C:\\ProgramData");
  for (const patch of [
    { nativeConsent: undefined },
    { externalConsent: undefined },
    { exerciseUI: true },
    { mechanismOnlyUpgrade: true },
    { newInstaller: undefined },
  ])
    assert.throws(() =>
      validateInstalledNativeSearchMode({ ...options, ...patch }),
    );
});
const receipt = (operation) => ({
  schemaVersion: 1,
  identity: { threadId: "thread" },
  toolCallId:
    operation === "search" ? NATIVE_FIRST_SEARCH_CALL : NATIVE_FIRST_FETCH_CALL,
  operation,
  status: "partial",
  sources: [
    {
      url: NATIVE_FIRST_FETCH_URL,
      readStatus: operation === "search" ? "summary_only" : "partial",
    },
  ],
});
test("native reading cannot be replaced by a summary or another tool receipt", () => {
  validateNativeSearchReceipt(receipt("search"), "thread");
  validateNativeFetchReceipt(receipt("fetch"), "thread");
  for (const patch of [
    { toolCallId: "forged" },
    { operation: "search" },
    { identity: { threadId: "other" } },
    { sources: [{ url: NATIVE_FIRST_FETCH_URL, readStatus: "summary_only" }] },
  ])
    assert.throws(() =>
      validateNativeFetchReceipt({ ...receipt("fetch"), ...patch }, "thread"),
    );
});
test("installed native result must bind the ordinary installer SID and actual clean image", () => {
  const identity = {
    build_commit: "a".repeat(40),
    build_dirty: false,
    executable_sha256: "b".repeat(64),
  };
  const result = {
    verificationScope: "installed_native_default_web",
    steps: [
      { action: "install", sid: "ordinary" },
      { action: "nativeWebSearch", sid: "ordinary", isAdmin: false },
    ],
    nativeWebSearch: {
      passed: true,
      searchConfigurationWritten: false,
      mcpConfigurationWritten: false,
      externalModelCalls: 0,
      controlledProviderRequests: 3,
      permissionMode: "ask",
      approvals: [{toolCallId: NATIVE_FIRST_SEARCH_CALL, tool: "WebSearch", decision: "accept", resolved: true},
        {toolCallId: NATIVE_FIRST_FETCH_CALL, tool: "WebFetch", decision: "accept", resolved: true}],
      buildIdentity: identity,
      receipt: receipt("search"),
      page: receipt("fetch"),
    },
  };
  const expected = {
    expectedCommit: identity.build_commit,
    expectedCliSha256: identity.executable_sha256,
  };
  validateInstalledNativeSearchResult(result, expected);
  for (const change of [
    (r) => {
      r.steps[1].sid = "other";
    },
    (r) => {
      r.steps[1].isAdmin = true;
    },
    (r) => { r.nativeWebSearch.approvals.pop(); },
    (r) => { r.nativeWebSearch.permissionMode = "yolo"; },
    (r) => {
      r.nativeWebSearch.mcpConfigurationWritten = true;
    },
    (r) => {
      r.nativeWebSearch.page.sources[0].readStatus = "summary_only";
    },
  ]) {
    const altered = structuredClone(result);
    change(altered);
    assert.throws(() => validateInstalledNativeSearchResult(altered, expected));
  }
});

test("approval replies bind only the observed native tool, thread and fixed public input", async () => {
  const { nativeApprovalResponse, NATIVE_FIRST_SEARCH_QUERY } =
    await import("./windows-native-web-search.mjs");
  const frame = {
    method: "approval/request",
    params: {
      threadId: "thread",
      turnId: "turn",
      approvalId: "approval",
      appServerEpoch: "epoch",
      toolCallId: NATIVE_FIRST_SEARCH_CALL,
      action: {
        type: "tool",
        name: "WebSearch",
        input: { query: NATIVE_FIRST_SEARCH_QUERY, num_results: 3 },
      },
    },
  };
  assert.deepEqual(nativeApprovalResponse(frame, "thread", "turn"), {
    approvalId: "approval",
    threadId: "thread",
    turnId: "turn",
    decision: "accept",
  });
  for (const mutate of [
    (v) => {
      v.params.threadId = "other";
    },
    (v) => { v.params.toolCallId = "other-call"; },
    (v) => { delete v.params.appServerEpoch; },
    (v) => { v.params.turnId = "other-turn"; },
    (v) => {
      v.params.action.name = "bash";
    },
    (v) => {
      v.params.action.input.query = "other";
    },
    (v) => {
      v.params.action = {
        type: "tool",
        name: "WebFetch",
        input: { url: "http://127.0.0.1/" },
      };
    },
  ]) {
    const bad = structuredClone(frame);
    mutate(bad);
    assert.throws(() => nativeApprovalResponse(bad, "thread", "turn"));
  }
});

test("zero-public actual JSONL child completes one exact ASK accept and resolved receipt", async () => {
  const { spawn } = await import("node:child_process");
  const { AppServerStdioClient } = await import("./app-server-stdio.mjs");
  const { acceptPendingNativeApproval, NATIVE_FIRST_SEARCH_QUERY } =
    await import("./windows-native-web-search.mjs");
  const request = {
    jsonrpc: "2.0",
    id: 7,
    method: "approval/request",
    params: {
      approvalId: "approval",
      appServerEpoch: "epoch",
      toolCallId: NATIVE_FIRST_SEARCH_CALL,
      threadId: "thread",
      turnId: "turn",
      action: {
        type: "tool",
        name: "WebSearch",
        input: { query: NATIVE_FIRST_SEARCH_QUERY, num_results: 3 },
      },
    },
  };
  const source = `const rl=require('node:readline').createInterface({input:process.stdin});console.log(${JSON.stringify(JSON.stringify(request))});rl.once('line',line=>{const f=JSON.parse(line);if(f.id!==7||f.result.decision!=='accept')process.exit(9);console.log(JSON.stringify({jsonrpc:'2.0',method:'approval/resolved',params:{requestId:7,appServerEpoch:'epoch',...f.result}}));});`;
  const child = spawn(process.execPath, ["-e", source], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const rpc = new AppServerStdioClient("approval protocol", child);
  try {
    const deadline = Date.now() + 3000;
    while (!rpc.pendingServerRequests().length && Date.now() < deadline)
      await new Promise((accept) => setTimeout(accept, 10));
    const receipt = await acceptPendingNativeApproval(rpc, "thread", "turn");
    assert.equal(receipt.resolved, true);
    assert.equal(receipt.requestId, 7);
    assert.equal(receipt.decision, "accept");
    assert.equal(rpc.pendingServerRequests().length, 0);
  } finally {
    rpc.closeReader();
    child.stdin.end();
    child.kill();
    await new Promise((accept) => {
      if (child.exitCode !== null) return accept();
      child.once("close", accept);
    });
  }
});


test("a second request cannot authorize the same fixed tool call again", async () => {
  const { acceptPendingNativeApproval, NATIVE_FIRST_SEARCH_QUERY } =
    await import("./windows-native-web-search.mjs");
  const seen = new Set([NATIVE_FIRST_SEARCH_CALL]);
  let responses = 0;
  const rpc = {
    pendingServerRequests: () => [{
      id: 8, method: "approval/request", params: {
        approvalId: "approval-8", appServerEpoch: "epoch",
        threadId: "thread", turnId: "turn",
        toolCallId: NATIVE_FIRST_SEARCH_CALL,
        action: { type: "tool", name: "WebSearch",
          input: {query: NATIVE_FIRST_SEARCH_QUERY, num_results: 3} },
      },
    }],
    respond: async () => { responses++; },
  };
  await assert.rejects(acceptPendingNativeApproval(rpc, "thread", "turn", seen),
    /Only one authorization/);
  assert.equal(responses, 0);
});


test("Windows PowerShell UTF8 request BOM is decoded without leaking invalid input", () => {
  const value = { installDirectory: "C:\\owned\\Installed Studio", marker: "\u4e2d\u6587" };
  assert.deepEqual(parseNativeWorkerInput("\uFEFF" + JSON.stringify(value)), value);
  assert.deepEqual(parseNativeWorkerInput(JSON.stringify(value)), value);
  assert.throws(() => parseNativeWorkerInput('{"credential":"private-input"'),
    error => error.message === "Owned native worker input is invalid JSON" &&
      !error.message.includes("private-input"));
});


test("unconfigured permission settings keep default Ask without pretending an explicit setting", () => {
  for (const persistedPermissionMode of [null, "ask"])
    validateNativePermissionDefaults({persistedPermissionMode, effectivePermissionMode: "ask", cliPermissionModeOverride: null});
  for (const patch of [{persistedPermissionMode: "yolo"}, {effectivePermissionMode: "auto"}, {cliPermissionModeOverride: "ask"}])
    assert.throws(() => validateNativePermissionDefaults({persistedPermissionMode:null, effectivePermissionMode:"ask", cliPermissionModeOverride:null, ...patch}));
});

test("failed native calls retain only bounded typed observations without output or URLs", () => {
  const receipt = { method: "item/completed", params: { item: {
    type: "toolCall", id: NATIVE_FIRST_SEARCH_CALL, status: "failed",
    output: "private stderr", webSources: { status: "failed", failure: "unsupported",
      sources: [{url: "https://private.invalid/credential", readStatus: "unreadable"}],
      attempts: [{provider:"exa-public", status:"failed", error:"unsupported", requestSent:false, detail:"private detail"}],
    },
  }}};
  const observations = nativeToolCallObservations([receipt, receipt, {method:"item/completed",params:{item:{type:"toolCall",id:"unrelated",output:"private"}}}]);
  assert.deepEqual(observations,[{toolCallId:NATIVE_FIRST_SEARCH_CALL,status:"failed",sourceStatus:"failed",failure:"unsupported",readStatuses:["unreadable"],attempts:[{provider:"exa-public",status:"failed",elapsedMs:null,error:"unsupported",requestSent:false}]}]);
  assert.ok(!JSON.stringify(observations).includes("private"));
});


test("malformed source observations cannot hide the original worker failure", () => {
  for (const webSources of [null, {sources: "unexpected", attempts: {}}, {sources:[null],attempts:[null]}])
    assert.doesNotThrow(() => nativeToolCallObservations([{method:"item/completed",params:{item:{type:"toolCall",id:NATIVE_FIRST_FETCH_CALL,webSources}}}]));
});

test("actual Windows PowerShell BOM reaches the bounded native worker bootstrap", {
  skip: process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST !== "1" || !process.env.KCODER_E2E_WINDOWS_SSH_TARGET,
}, async () => {
  const { randomUUID } = await import("node:crypto");
  const { writeFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { runE2E } = await import("./run-context.mjs");
  const { windowsSshInvocation } = await import("./windows-ssh-auth.mjs");
  const target = process.env.KCODER_E2E_WINDOWS_SSH_TARGET;
  const node = process.env.KCODER_E2E_WINDOWS_NODE;
  assert.match(target, /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/);
  assert.match(node ?? "", /^[A-Za-z]:\\[^'"\r\n]+\.exe$/);
  const owner = randomUUID();
  const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$root=Join-Path ([IO.Path]::GetTempPath()) ('kcoder-native-bootstrap-'+$q.owner);$marker=Join-Path $root '.owner';if($q.cleanup){$terminated=0;foreach($a in $q.actors){try{$p=[Diagnostics.Process]::GetProcessById([int]$a.pid)}catch [ArgumentException]{continue};try{$held=$p.Handle;if($p.StartTime.ToUniversalTime().Ticks.ToString() -cne $a.creationTicks){continue};$c=Get-CimInstance Win32_Process -Filter ('ProcessId='+$a.pid);if(!$c -or $c.Name -cne 'powershell.exe' -or !$c.CommandLine.Contains([string]$a.encoded)){throw 'Control actor identity mismatch'};$p.Kill();if(!$p.WaitForExit(5000)){throw 'Owned control actor did not exit'};$terminated++}finally{$p.Dispose()}};if(Test-Path -LiteralPath $root){if([IO.File]::ReadAllText($marker) -cne $q.owner){throw 'Owner mismatch'};[IO.Directory]::Delete($root,$true)};@{directoryAbsent=!(Test-Path -LiteralPath $root);controlActorsTerminated=$terminated}|ConvertTo-Json -Compress;exit};if($q.prepare){if(Test-Path -LiteralPath $root){throw 'Fixture collision'};[void][IO.Directory]::CreateDirectory($root);[IO.File]::WriteAllText($marker,$q.owner);@{directory=$root}|ConvertTo-Json -Compress;exit};if([IO.File]::ReadAllText($marker) -cne $q.owner){throw 'Owner mismatch'};try{$inputPath=Join-Path $root 'request.json';@{runRoot=$root;installDirectory=$root;nativeConsent='0';externalConsent='0'}|ConvertTo-Json -Compress|Set-Content -LiteralPath $inputPath -Encoding UTF8;$bytes=[IO.File]::ReadAllBytes($inputPath);$bom=($bytes.Length -gt 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191);$start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$q.node;$start.Arguments='"'+(Join-Path $root 'windows-native-web-search.mjs')+'" "'+$inputPath+'"';$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true;$child=[Diagnostics.Process]::new();$child.StartInfo=$start;try{if(!$child.Start()){throw 'Worker did not start'};$output=$child.StandardOutput.ReadToEndAsync();$errorOutput=$child.StandardError.ReadToEndAsync();if(!$child.WaitForExit(15000)){& taskkill /PID $child.Id /T /F 2>$null|Out-Null;throw 'Owned bootstrap timeout'};$text=$output.GetAwaiter().GetResult();$stderr=$errorOutput.GetAwaiter().GetResult();if($text.Length -gt 4096){throw 'Bootstrap output too large'};$value=$text|ConvertFrom-Json;if($child.ExitCode -ne 1 -or $value.phase -cne 'worker-bootstrap' -or $value.errorMessage -notlike '*Explicit native Windows consent is required*'){throw 'BOM did not reach the expected consent boundary'};@{passed=$true;utf8Bom=$bom;phase=$value.phase;nativeConsentRejected=$true;stderrBytes=[Text.Encoding]::UTF8.GetByteCount($stderr);rawStderrPersisted=$false;publicRequests=0;models=0;settingsWritten=$false;accountCreated=$false}|ConvertTo-Json -Compress}finally{$child.Dispose()}}finally{if([IO.File]::ReadAllText($marker) -cne $q.owner){throw 'Owner changed'};[IO.Directory]::Delete($root,$true)}`;
  await runE2E(import.meta.url, {testId:"windows-native-worker-bom-bootstrap",tier:"manual-live",cleanupTimeoutMs:45000,
    modelPolicy:"Actual Windows PowerShell UTF8 BOM and Node worker input/consent boundary only; native and external consent deliberately rejected before creating profiles, models or network requests."}, async context => {
    context.registerSecret(owner);
    const controls = [];
    const execute = mode => new Promise((accept, reject) => {
      const cleanup = mode === "cleanup";
      const actorSnapshot = cleanup ? [...controls] : [];
      const controlSource = "[Console]::Out.WriteLine((@{controlPid=$PID;creationTicks=([Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString())}|ConvertTo-Json -Compress));" + (mode === "blocked" ? "Start-Sleep -Seconds 120;" : "") + "$q=[Console]::In.ReadToEnd()|ConvertFrom-Json;& ([ScriptBlock]::Create([string]$q.script))";
      const encoded = Buffer.from(controlSource,"utf16le").toString("base64");
      const args = ["-o","BatchMode=yes","-o","ConnectTimeout=10",target,"powershell","-NoProfile","-NonInteractive","-EncodedCommand",encoded];
      const spec = windowsSshInvocation(context,"ssh",args,target);
      const spawn = cleanup ? context.spawnCleanupOwned.bind(context) : context.spawnOwned.bind(context);
      const child = spawn("bootstrap-"+mode,spec.command,spec.args,{...spec.options,stdin:"pipe",signal:AbortSignal.timeout(mode === "blocked" ? 1500 : 30000)});
      let stdout = "", bytes = 0, controlSeen = false, protocolError;
      child.stdout.on("data", data => {
        bytes += data.length;
        if(bytes > 8192) return;
        stdout += data;
        const newline = stdout.indexOf("\n");
        if(!controlSeen && newline >= 0) {
          try {
            const actor = JSON.parse(stdout.slice(0,newline));
            assert.ok(Number.isInteger(actor.controlPid) && actor.controlPid > 0);
            assert.match(actor.creationTicks,/^[0-9]{18}$/);
            controls.push({pid:actor.controlPid,creationTicks:actor.creationTicks,encoded});
            controlSeen = true;stdout = stdout.slice(newline+1);
          } catch { protocolError = Error("Invalid owned control actor receipt"); }
        }
      });
      child.stderr.resume();
      child.once("error",reject);
      child.once("close",code => {
        if(protocolError) return reject(protocolError);
        if(code !== 0 || bytes > 8192 || !controlSeen) return reject(Error("Owned Windows BOM probe failed"));
        try { accept(JSON.parse(stdout.trim())); } catch { reject(Error("Invalid owned bootstrap result")); }
      });
      child.stdin.end(JSON.stringify({owner,node,cleanup,prepare:mode === "prepare",script,actors:actorSnapshot}));
    });
    const cleanupPath = context.pathInArtifacts("windows-bootstrap-cleanup.json");
    context.addCleanup("remove only the exact owned native bootstrap directory", async () => {
      const cleanup = await execute("cleanup");
      assert.equal(cleanup.directoryAbsent,true);
      assert.equal(cleanup.controlActorsTerminated,1,"The deliberate blocked control must be reaped");
      await writeFile(cleanupPath,JSON.stringify(cleanup),{mode:0o600});
    });
    const prepared = await execute("prepare");
    assert.ok(typeof prepared.directory === "string" && prepared.directory.endsWith("kcoder-native-bootstrap-"+owner));
    for (const leaf of ["windows-native-web-search.mjs", "app-server-stdio.mjs", "windows-native-web-model.mjs", "windows-managed-pac-fixture.mjs"]) {
      await new Promise((accept,reject) => {
        const args = ["-o","BatchMode=yes","-o","ControlPath=none",fileURLToPath(new URL(leaf,import.meta.url)),target+":"+prepared.directory.replaceAll("\\","/")+"/"+leaf];
        const spec = windowsSshInvocation(context,"scp",args,target);
        const child = context.spawnOwned("bootstrap-upload-"+leaf,spec.command,spec.args,{...spec.options,stdin:"ignore",signal:AbortSignal.timeout(30000)});
        child.stdout.resume();child.stderr.resume();child.once("error",reject);
        child.once("close",code => code === 0 ? accept() : reject(Error("Owned bootstrap source transfer failed")));
      });
    }
    const result = await execute("probe");
    assert.equal(result.passed,true);assert.equal(result.utf8Bom,true);
    assert.equal(result.stderrBytes,0);assert.equal(result.publicRequests,0);
    await context.writeArtifactJson("windows-native-worker-bom.json",result);
    await assert.rejects(execute("blocked"), /aborted|Owned Windows BOM probe failed/i);
    assert.ok(controls.length >= 3,"Each control actor must publish identity before reading stdin");
    return {...result,blockedControlCleanupRequested:true};
  });
});

test("controlled case agrees with the prepared transport fixture payload",async()=>{const {windowsManagedPacPayload}=await import("./windows-managed-pac-fixture.mjs");const id="11111111-2222-3333-4444-555555555555";const a=controlledPacNativeCase(id),b=windowsManagedPacPayload(id);assert.equal(a.marker,b.marker);assert.equal(a.nativeQuery,b.nativeQuery);assert.deepEqual(a.expectedSources,b.expectedSources.map(source=>source.url));});
