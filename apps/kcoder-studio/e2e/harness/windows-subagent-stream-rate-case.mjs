import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises';
import { AppServerStdioClient, waitForStdioChildClose } from './app-server-stdio.mjs';

const readPhases = ['scope_open_us', 'owner_open_us', 'records_us', 'policy_us', 'owner_close_us', 'scope_close_us'];
const readFields = new RegExp(`\\b(${[...readPhases, 'output_fragments'].join('|')})=(\\d+)\\b`, 'g');
const percentile = (values, q) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * q)];
async function until(predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error(`Timed out: ${label}`);
}

async function inheritedSourceCount(profile, threadId) {
  for (const domain of await readdir(profile, { withFileTypes: true })) {
    if (!domain.isDirectory() || !domain.name.startsWith('integration-')) continue;
    const directory = join(profile, domain.name);
    for (const name of await readdir(directory)) {
      if (!/^source-binding-[a-f0-9]{64}\.json$/.test(name)) continue;
      const { snapshot } = JSON.parse(await readFile(join(directory, name), 'utf8'));
      if (snapshot?.threadId === threadId && snapshot.selection?.mode === 'inherit_current') {
        return snapshot.effectiveSources.length;
      }
    }
  }
  return undefined;
}

const ownedMcpSource = `
const lines = require('node:readline').createInterface({ input: process.stdin });
lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.id == null) return;
  const result = request.method === 'initialize'
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'owned-native-source', version: '1' } }
    : { tools: [{ name: 'owned_source_probe', description: 'Owned source catalog probe', inputSchema: { type: 'object' } }] };
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
});
`;

async function whileCatalogWriterHoldsLock(profile, act) {
  const candidates = (await readdir(profile, { withFileTypes: true }))
    .filter(domain => domain.isDirectory() && domain.name.startsWith('integration-'))
    .map(domain => join(profile, domain.name, 'native-sources.lock'));
  const locks = (await Promise.all(candidates.map(path => access(path).then(() => path, () => null)))).filter(Boolean);
  assert.equal(locks.length, 1, 'the owned profile contains one native source catalog');
  const pathBase64 = Buffer.from(locks[0], 'utf8').toString('base64');
  const powerShell = `
$ErrorActionPreference = 'Stop'
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pathBase64}'))
$file = [IO.File]::Open($path, 'Open', 'ReadWrite', 'ReadWrite,Delete')
try {
  $file.Lock(0, 1)
  [Console]::WriteLine('locked')
  [void] [Console]::ReadLine()
  $file.Unlock(0, 1)
} finally { $file.Dispose() }
`;
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(powerShell, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  holder.stdin.on('error', () => {});
  holder.stderr.resume();
  const closed = waitForStdioChildClose(holder, 10000, 'owned source catalog writer');
  const lines = createInterface({ input: holder.stdout });
  try {
    const first = await Promise.race([
      lines[Symbol.asyncIterator]().next(),
      closed.then(() => { throw Error('Source catalog writer exited before acquiring the lock'); }),
    ]);
    assert.equal(first.value, 'locked');
    act();
    await delay(120);
  } finally {
    holder.stdin.end('\n');
    lines.close();
    await closed;
  }
}

/** Runs inside the existing owned Windows Job; no installed app or personal profile. */
export async function runWindowsSubagentStreamRateCase({ root, binary, environment, children = 1, longOutput = false, profileOutputReads = false, exerciseSources = false }) {
  assert.ok([1, 4].includes(children), 'supported child concurrency');
  const count = longOutput ? 384 : 192;
  const bodyText = longOutput ? 'This is ordinary streamed text with 中文 markers.\n'.repeat(8) : '';
  const completionTokensPerFragment = longOutput ? 96 : 1;
  const maxOutputTokens = longOutput ? 65536 : 4096;
  const results = [];
  const violations = [];
  for (const intervalMs of children === 1 ? [0, 15, 6] : [6, 0]) {
    const childLanes = Array.from({ length: children }, (_, index) => `C${index + 1}`);
    const lanes = ['M', ...childLanes];
    const directory = join(root, `rate-${intervalMs}-${children}`), profile = join(directory, 'profile');
    const workspace = join(directory, 'workspace');
    for (const path of [profile, join(profile, 'cache'), workspace]) await mkdir(path, { recursive: true });
    const sent = Object.fromEntries(lanes.map(lane => [lane, []]));
    const received = Object.fromEntries(lanes.map(lane => [lane, []]));
    const gates = new Map(), subscriptions = new Map(), terminal = new Map();
    const childToolRounds = new Map();
    const toolRounds = exerciseSources ? 4 : 0;
    let threadId, requests = 0, resets = 0, fixtureError, diagnostics = '', failure;
    const progress = () => lanes.map(lane =>
      `${lane} ${received[lane].length}/${count} ${terminal.get(lane) ?? 'active'}`).join(', ');
    const server = createServer(async (request, response) => {
      try {
        if (request.method === 'HEAD') { response.writeHead(200); response.end(); return; }
        assert.equal(request.method, 'POST');
        let bytes = 0; const chunks = [];
        for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes < 2 * 1024 * 1024); chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks));
        const requestId = ++requests;
        assert.ok(requestId <= children * (toolRounds + 1) + 7);
        const prompt = body.messages.find(message =>
          message.role === 'user' && /RATE_(PARENT|CHILD_)/.test(JSON.stringify(message.content)));
        const lane = /RATE_CHILD_(C[1-4])/.exec(JSON.stringify(prompt?.content))?.[1] ?? 'M';
        assert.ok(lanes.includes(lane), 'provider stream must belong to an owned lane');
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        const frame = (delta, usage, finish_reason = null) => response.write(`data: ${JSON.stringify({
          id: `owned-${requestId}`, object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason }], ...(usage && { usage }),
        })}\n\n`);
        if (!prompt || lane === 'M' && gates.has('M')) {
          frame({ content: 'READY' }, null, 'stop'); response.end('data: [DONE]\n\n'); return;
        }
        if (lane === 'M' && !body.messages.some(m => m.role === 'tool')) {
          frame({ tool_calls: childLanes.map((childLane, index) => ({
            index, id: `owned-rate-spawn-${childLane}`, type: 'function', function: {
              name: 'spawn_agent', arguments: JSON.stringify({
                message: `RATE_CHILD_${childLane}`, agent_type: 'general',
                context_mode: 'none', run_in_background: true,
              }),
            },
          })) }, null, 'tool_calls');
        } else if (lane !== 'M' && (childToolRounds.get(lane) ?? 0) < toolRounds) {
          const round = (childToolRounds.get(lane) ?? 0) + 1;
          childToolRounds.set(lane, round);
          frame({ tool_calls: [{
            index: 0, id: `owned-read-${lane}-${round}`, type: 'function', function: {
              name: 'glob', arguments: JSON.stringify({ pattern: '*.txt' }),
            },
          }] }, null, 'tool_calls');
        } else {
          assert.ok(!gates.has(lane), `duplicate provider stream for ${lane}`);
          // Set up subscriptions while the providers have sent only headers.
          // The first measured fragment also opens the model's message.
          response.flushHeaders();
          await new Promise(resolve => { gates.set(lane, resolve); });
          const start = performance.now();
          for (let i = 0; i < count; i++) {
            // Yield without changing Windows timer resolution or machine policy.
            while (performance.now() < start + intervalMs * i) await immediate();
            sent[lane][i] = Date.now();
            const completionTokens = (i + 1) * completionTokensPerFragment;
            frame({ ...(i === 0 && { role: 'assistant' }), content: `${lane}_${String(i).padStart(3, '0')}·${bodyText}` },
              { prompt_tokens: 8, completion_tokens: completionTokens, total_tokens: 8 + completionTokens });
          }
          frame({}, null, 'stop');
        }
        response.end('data: [DONE]\n\n');
      } catch (error) { fixtureError = error; response.destroy(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await writeFile(join(profile, 'settings.json'), JSON.stringify({
      credential_store: 'file', permission_mode: 'yolo', max_retries: 0,
      max_concurrent_subagents: children,
      auto_memory_enabled: false, auto_tool_memory_enabled: false, session_memory: { enabled: false },
      mcp_servers: exerciseSources ? [{ name: 'owned-source', transport: 'stdio', command: process.execPath, args: ['-e', ownedMcpSource] }] : [],
      ...(exerciseSources && { integrations: { connectivity: { enabled: true } } }),
      hooks: {}, active_provider: 'owned', providers: { owned: {
        api_format: 'openai_chat_completions', authentication: { mode: 'none' },
        endpoint: `http://127.0.0.1:${server.address().port}/v1`, default_model: 'owned-model',
        discover_models: false, no_proxy: true, context_window_tokens: 128000,
        max_output_tokens: maxOutputTokens, output_headroom_tokens: maxOutputTokens,
      } },
    }));
    const child = spawn(binary, ['--cwd', workspace, 'app-server'], {
      cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...environment, HOME: profile, USERPROFILE: profile, APPDATA: profile, LOCALAPPDATA: profile,
        ...(profileOutputReads ? { RUST_LOG: 'warn,kcoder_child_output_read=trace' } : {}),
        KCODER_HOME: profile, KCODER_CONFIG_DIR: profile, KCODER_CACHE_DIR: join(profile, 'cache') },
    });
    child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-12000); });
    const readTimingSamples = [];
    const profileReader = profileOutputReads ? createInterface({ input: child.stderr }) : null;
    profileReader?.on('line', line => {
      if (!line.includes('kcoder_child_output_read') || readTimingSamples.length >= count * lanes.length + 64) return;
      const sample = Object.fromEntries(Array.from(line.matchAll(readFields), ([, key, value]) => [key, Number(value)]));
      if (readPhases.every(key => Number.isFinite(sample[key]))) readTimingSamples.push(sample);
    });
    const client = new AppServerStdioClient('owned-windows-rate', child, { defaultTimeoutMs: 30000 });
    const rpc = async (method, params) => {
      const frame = await client.request(method, params);
      if (frame.error) throw Error(`${method}: ${JSON.stringify(frame.error)}`);
      return frame.result;
    };
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => {
      const frame = JSON.parse(line), isChild = frame.method === 'agent/stream/event';
      if (frame.method === 'agent/stream/reset') resets++;
      const lane = isChild ? subscriptions.get(frame.params.subscriptionId) :
        frame.params?.threadId === threadId ? 'M' : undefined;
      if (!lane) return;
      const method = isChild ? frame.params.method : frame.method;
      const params = isChild ? frame.params.params : frame.params;
      if (method === 'turn/completed') terminal.set(lane, params.turn.status);
      if (method !== 'item/delta' || typeof params?.delta?.text !== 'string') return;
      for (const match of params.delta.text.matchAll(new RegExp(lane + '_(\\d{3})·', 'g'))) {
        received[lane].push({ index: Number(match[1]), at: Date.now(), nativeAt: isChild ? frame.params.occurredAtMs : params.occurredAtMs });
      }
    });
    try {
      const initialized = await rpc('initialize', { protocolVersion: '2026-07-27',
        clientInfo: { name: 'owned-windows-stream-rate', version: '1' }, capabilities: { experimental: {
          integrationScopeV1: true, taskSourcesV1: true, agentLiveViewV1: true,
          threadCreationReceiptsV1: true,
        } } });
      for (const name of ['integrationScopeV1', 'taskSourcesV1', 'agentLiveViewV1'])
        assert.equal(initialized.capabilities.experimental[name], true, name);
      threadId = (await rpc('thread/start', { cwd: workspace, clientRequestId: randomUUID() })).thread.id;
      await rpc('turn/start', { threadId, input: [{ type: 'text', text: 'RATE_PARENT' }] });
      const agents = await until(async () => {
        if (fixtureError) throw fixtureError;
        if (gates.size !== lanes.length) return false;
        const { agents } = await rpc('agent/list', { threadId });
        return agents.length === children && agents.every(agent => agent.backgroundRun) && agents;
      }, 'main provider and all child providers ready');
      for (const lane of childLanes) {
        const agent = agents.find(agent => agent.parentToolCallId === `owned-rate-spawn-${lane}`);
        assert.ok(agent, `real child identity for ${lane}`);
        const subscriptionId = randomUUID();
        subscriptions.set(subscriptionId, lane);
        await rpc('agent/stream/subscribe', {
          threadId, agentId: agent.agentId, subscriptionId, expectedBackgroundRun: agent.backgroundRun,
        });
      }
      // Release the providers together so the streams share real Native
      // authorization and app-server transport resources.
      const releaseProviders = () => { for (const lane of lanes) gates.get(lane)(); };
      if (exerciseSources) {
        assert.equal(await inheritedSourceCount(profile, threadId), 1, 'the task inherited the MCP source');
        await whileCatalogWriterHoldsLock(profile, releaseProviders);
      } else releaseProviders();
      await until(() => {
        if (fixtureError) throw fixtureError;
        if (exerciseSources && [...terminal.values()].some(status => status === 'failed')) {
          throw Error('a source-authorized turn failed during the writer overlap');
        }
        return lanes.every(lane => received[lane].length >= count && terminal.has(lane));
      }, 'all native streams are terminal');
      for (const lane of lanes) {
        assert.equal(terminal.get(lane), 'completed');
        assert.deepEqual(received[lane].map(s => s.index), Array.from({ length: count }, (_, i) => i));
      }
      const timings = {};
      for (const lane of lanes) {
        const delays = received[lane].map(s => s.nativeAt - sent[lane][s.index]);
        const wire = received[lane].map(s => s.at - sent[lane][s.index]);
        const delivery = received[lane].map(s => s.at - s.nativeAt);
        assert.ok(delays.every(Number.isFinite), 'all fragments carry a real Native timestamp');
        const quarter = count / 4;
        timings[lane] = { count, firstNativeDelayMs: delays[0], nativeP95Ms: percentile(delays, .95),
          firstQuarterP50Ms: percentile(delays.slice(0, quarter), .5),
          lastQuarterP50Ms: percentile(delays.slice(-quarter), .5),
          lastNativeDelayMs: delays.at(-1),
          firstWireDelayMs: wire[0], wireP95Ms: percentile(wire, .95), lastWireDelayMs: wire.at(-1),
          nativeToWireP95Ms: percentile(delivery, .95),
          observedMeanIntervalMs: (sent[lane].at(-1) - sent[lane][0]) / (count - 1) };
        if (timings[lane].lastQuarterP50Ms >= timings[lane].firstQuarterP50Ms + 350) {
          violations.push({ lane, intervalMs, reason: 'native_backlog' });
        }
        if (delays.at(-1) >= 750) violations.push({ lane, intervalMs, reason: 'native_tail' });
      }
      assert.equal(resets, 0);
      if (exerciseSources) {
        assert.deepEqual([...childToolRounds.values()], Array(children).fill(toolRounds));
      }
      let outputReadTiming;
      if (profileOutputReads) {
        await until(() => readTimingSamples.length > 0, 'Native read timing samples', 1000);
        outputReadTiming = {
          samples: readTimingSamples.length,
          p50Us: Object.fromEntries(readPhases.map(key => [key, percentile(readTimingSamples.map(row => row[key]), .5)])),
          p95Us: Object.fromEntries(readPhases.map(key => [key, percentile(readTimingSamples.map(row => row[key]), .95)])),
        };
        if (readTimingSamples.every(row => Number.isFinite(row.output_fragments))) {
          const modelReads = readTimingSamples.map(row => row.output_fragments).filter(count => count > 0);
          outputReadTiming.modelReads = modelReads.length;
          outputReadTiming.modelFragments = modelReads.reduce((sum, count) => sum + count, 0);
          if (modelReads.length > 0) {
            outputReadTiming.fragmentsPerReadP50 = percentile(modelReads, .5);
            outputReadTiming.fragmentsPerReadP95 = percentile(modelReads, .95);
          }
        }
      }
      results.push({ requestedIntervalMs: intervalMs, children, timings, requests, resets, outputReadTiming,
        ...(exerciseSources && { inheritedSources: 1, toolRounds }),
      });
    } catch (error) {
      failure = Error(`${error.message} (${progress()})\n${diagnostics}`);
      throw failure;
    }
    finally {
      for (const release of gates.values()) release();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      child.stdin.end();
      try {
        await waitForStdioChildClose(child, 10000, 'owned Windows rate app-server');
      } catch (error) {
        throw new Error(`${failure?.message ?? progress()}\n${error.message}`, { cause: failure ?? error });
      } finally {
        reader.close();
        profileReader?.close();
      }
    }
  }
  return { passed: violations.length === 0, profiles: results, violations, realModelCalls: 0, installedPackageAcceptance: false };
}
