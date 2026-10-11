import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startLiveModelObserver } from "./live-model-observer.mjs";

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
      );
      const response = await fetch(observer.endpoint + "/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "fixture-only" },
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
