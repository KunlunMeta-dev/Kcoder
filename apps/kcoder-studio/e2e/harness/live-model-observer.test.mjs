import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startLiveModelObserver, liveModelRequestPath } from "./live-model-observer.mjs";

for (const protocol of ["anthropic", "openai"])
  test(`observer forwards ${protocol} SSE unchanged, records shape only and enforces request budget`, async () => {
    const frames =
      protocol === "openai"
        ? [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        function: { name: "Example", arguments: '{"x":1}' },
                      },
                    ],
                  },
                },
              ],
            },
            {
              choices: [{ delta: {}, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 12, completion_tokens: 8 },
            },
          ]
        : [
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", name: "Example", input: {} },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: '{"x":1}' },
            },
            {
              type: "message_delta",
              delta: { stop_reason: "tool_use" },
              usage: { output_tokens: 8 },
            },
          ];
    const body = frames
      .map((frame) => "data: " + JSON.stringify(frame) + "\n\n")
      .join("");
    const upstream = createServer(async (req, res) => {
      for await (const _ of req) {
      }
      assert.equal(req.headers["x-api-key"], "fixture-only");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(body);
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const cleanup = [];
    const secrets = [];
    const context = {
      addCleanup: (_, fn) => cleanup.push(fn),
      registerPort: () => {},
      registerSecret: (value) => secrets.push(value),
    };
    try {
      const observer = await startLiveModelObserver(
        context,
        `http://127.0.0.1:${upstream.address().port}`,
        1,
        protocol === "anthropic" ? {upstreamHeaders:{"x-api-key":"fixture-only"}, allowedPaths:["/v1/messages"]} : {},
      );
      const response = await fetch(observer.endpoint + "/v1/messages", {
        method: "POST",
        headers: { "x-api-key": observer.forwardToken ?? "fixture-only" },
        body: "{}",
      });
      assert.equal(await response.text(), body);
      assert.deepEqual(observer.observations[0].tools, [
        { name: "Example", chars: 7, valid: true },
      ]);
      assert.equal(
        observer.observations[0].stopReason,
        protocol === "openai" ? "tool_calls" : "tool_use",
      );
      assert.ok(secrets.includes("fixture-only"));
      assert.ok(
        !JSON.stringify(observer.observations).includes("fixture-only"),
      );
      const limited = await fetch(observer.endpoint + "/v1/messages", {
        method: "POST",
        headers: { "x-api-key": observer.forwardToken ?? "fixture-only" },
        body: "{}",
      });
      assert.equal(limited.status, 502);
      await limited.text();
    } finally {
      for (const fn of cleanup.reverse()) await fn();
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
    }
  });

test('live observer rejects an office input/output/cost admission before the actual upstream call', async () => {
  let dispatched = 0;
  const upstream = createServer((req,res) => { dispatched++; req.resume(); res.end('must not dispatch'); });
  await new Promise(resolve => upstream.listen(0,'127.0.0.1',resolve));
  const cleanup = [];
  const context = { addCleanup: (_label, fn) => cleanup.push(fn), registerPort() {}, registerSecret() {} };
  let observed;
  try {
    const observer = await startLiveModelObserver(context, `http://127.0.0.1:${upstream.address().port}`, 1, { beforeForward: metadata => { observed = metadata; throw Error('budget rejected'); } });
    const response = await fetch(`${observer.endpoint}/v1/messages`, { method:'POST', body:JSON.stringify({model:'office',max_tokens:4096,tools:[{name:'read'}],messages:[{role:'user',content:'Synthetic private prompt'}]}) });
    assert.equal(response.status,502); await response.text();
    assert.equal(dispatched,0);
    assert.deepEqual(observed.exposedToolNames,['read']); assert.equal(observed.outputTokenLimit,4096);
    assert.ok(!JSON.stringify(observed).includes('Synthetic private prompt'));
    assert.ok(!JSON.stringify(observer.observations).includes('Synthetic private prompt'));
  } finally {
    for (const fn of cleanup.reverse()) await fn();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
});

test('protected observer only forwards authenticated inference on exact paths and never records credentials or malformed tool contents', async () => {
  let dispatched = 0;
  const upstream = createServer(async (request, response) => {
    dispatched++;
    for await (const _ of request) {}
    assert.equal(request.headers['x-api-key'], 'upstream-fixture-only');
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers['proxy-authorization'], undefined);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({type:'content_block_start',index:0,content_block:{type:'tool_use',name:'read',input:{}}}) + '\n\n' +
      'data: ' + JSON.stringify({type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'private-tool-content'}}) + '\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const cleanup = [], secrets = [];
  const context = { addCleanup: (_label, fn) => cleanup.push(fn), registerPort() {}, registerSecret: value => secrets.push(value) };
  const endpoint = `http://127.0.0.1:${upstream.address().port}`;
  const options = { upstreamHeaders:{'x-api-key':'upstream-fixture-only'}, allowedPaths:['/v1/messages'] };
  try {
    await assert.rejects(startLiveModelObserver(context, endpoint, 1, {upstreamHeaders:options.upstreamHeaders}), /exact allowed request paths/);
    await assert.rejects(startLiveModelObserver(context, endpoint, 1, {...options, allowedPaths:['//other.invalid/v1/messages']}), /exact allowed request paths/);
    const observer = await startLiveModelObserver(context, endpoint, 1, options);
    const second = await startLiveModelObserver(context, endpoint, 1, options);
    assert.match(observer.forwardToken, /^[a-f0-9]{64}$/);
    assert.notEqual(observer.forwardToken, second.forwardToken);
    assert.ok(secrets.includes(observer.forwardToken));
    const headers = {authorization:`Bearer ${observer.forwardToken}`};
    for (const auth of [{}, {'x-api-key':'OWNED_FORWARD_AUTH'}, {authorization:`Bearer ${second.forwardToken}`}, {...headers,'x-api-key':'incorrect'}]) {
      const rejected = await fetch(`${observer.endpoint}/v1/messages`, {method:'POST',headers:auth,body:'{}'});
      assert.equal(rejected.status,401); await rejected.text();
    }
    for (const [method,path] of [['GET','/v1/messages'],['DELETE','/v1/messages'],['POST','/v1/admin'],['POST','/v1/messages?forward=admin'],['POST','/v1/%6dessages']]) {
      const rejected = await fetch(observer.endpoint + path, {method,headers,...(method === 'POST' ? {body:'{}'} : {})});
      assert.equal(rejected.status,403); await rejected.text();
    }
    const warmup = await fetch(`${observer.endpoint}/v1/messages`, {method:'HEAD',headers});
    assert.equal(warmup.status,204);
    assert.equal(dispatched,0);
    assert.deepEqual(observer.observations,[]);
    const forwarded = await fetch(`${observer.endpoint}/v1/messages`, {method:'POST',headers:{...headers,'x-api-key':observer.forwardToken,cookie:'local-cookie','proxy-authorization':'local-proxy'},body:'{}'});
    assert.equal(forwarded.status,200); await forwarded.text();
    assert.equal(dispatched,1);
    assert.deepEqual(observer.observations[0].tools,[{name:'read',chars:20,valid:false}]);
    for (const secret of [...secrets,'private-tool-content','local-cookie','local-proxy']) assert.ok(!JSON.stringify(observer.observations).includes(secret));
    const limited = await fetch(`${observer.endpoint}/v1/messages`, {method:'POST',headers,body:'{}'});
    assert.equal(limited.status,502); await limited.text();
    assert.equal(dispatched,1);
  } finally {
    for (const fn of cleanup.reverse()) await fn();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
});

test('observer waits for asynchronous admission before forwarding the unchanged request', async () => {
  let dispatched = 0, release, admitted;
  const gate = new Promise(resolve => { release = resolve; });
  const admission = new Promise(resolve => { admitted = resolve; });
  const upstream = createServer(async (request, response) => {
    dispatched++;
    let body = '';
    for await (const chunk of request) body += chunk;
    response.end(body);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const cleanup = [];
  const context = { addCleanup: (_label, fn) => cleanup.push(fn), registerPort() {}, registerSecret() {} };
  try {
    const observer = await startLiveModelObserver(context, `http://127.0.0.1:${upstream.address().port}`, 1, {
      beforeForward: async () => { admitted(); await gate; },
    });
    const body = JSON.stringify({ model: 'fixture', messages: [] });
    const response = fetch(`${observer.endpoint}/v1/messages`, { method: 'POST', body });
    await admission;
    assert.equal(dispatched, 0);
    release();
    assert.equal(await (await response).text(), body);
    assert.equal(dispatched, 1);
  } finally {
    release();
    for (const fn of cleanup.reverse()) await fn();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
});

test('protected model request paths follow the selected native provider URL rules', () => {
  for (const [endpoint, format, expected] of [
    ['https://example.invalid/anthropic/', 'anthropic_messages', '/anthropic/v1/messages'],
    ['https://example.invalid', 'anthropic_messages', '/v1/messages'],
    ['https://example.invalid/v1/', 'openai_chat_completions', '/v1/chat/completions'],
    ['https://example.invalid/v1/chat/completions', 'openai_chat_completions', '/v1/chat/completions'],
    ['https://example.invalid/v1', 'openai_responses', '/v1/responses'],
    ['https://example.invalid/v1/responses/', 'openai_responses', '/v1/responses'],
  ]) assert.equal(liveModelRequestPath(endpoint,format),expected);
  assert.throws(() => liveModelRequestPath('https://example.invalid','other'), /Unsupported protected model API/);
});
