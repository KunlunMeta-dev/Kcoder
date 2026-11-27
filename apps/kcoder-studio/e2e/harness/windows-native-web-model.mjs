import assert from "node:assert/strict";
import {createServer} from "node:http";

/** Bounded localhost model protocol only; no external model or search behavior is simulated. */
export function createNativeWebModelFixture({bundled,query,searchCallId,fetchCallId,fetchUrl}) {
  const toolCalls=bundled?1:2,requestLimit=toolCalls+1;
  const observations = [];
  let requests = 0,
    nativeToolOffered = false,
    fixtureFailure;
  const server = createServer(async (request, response) => {
    try {
      let body = "",
        bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert.ok(bytes <= 2 * 1024 * 1024);
        body += chunk;
      }
      const method = ["GET","HEAD","POST"].includes(request.method) ? request.method : "other";
      const path = new URL(request.url, "http://127.0.0.1").pathname;
      observations.push({method,path:["/v1/models","/models","/v1/chat/completions"].includes(path)?path:"other",bytes});
      assert.ok(observations.length <= 16,"Owned fixture HTTP request count exceeded");
      if (method === "HEAD" && path === "/v1/chat/completions") {
        assert.equal(bytes,0,"Provider warmup HEAD must have no request body");
        response.writeHead(200,{"Content-Type":"application/json"});
        response.end();
        return;
      }
      if (method === "GET" && ["/v1/models","/models"].includes(path)) {
        assert.equal(bytes,0,"Model catalogue GET must have no request body");
        response.writeHead(200,{"Content-Type":"application/json"});
        response.end(JSON.stringify({object:"list",data:[{id:"fixture",object:"model"}]}));
        return;
      }
      if (method !== "POST" || path !== "/v1/chat/completions")
        throw Error("Unsupported owned fixture method or path");
      let message;
      try { message=JSON.parse(body); } catch { throw Error("Owned chat request is not valid JSON"); }
      const index = requests++;
      assert.ok(
        index < requestLimit,
        "The owned model protocol exceeded this scope's fixed response count",
      );
      nativeToolOffered ||=
        message.tools?.some(
          (tool) =>
            tool.type === "function" && tool.function?.name === "WebSearch",
        ) === true;
      assert.ok(
        nativeToolOffered,
        "The actual native tool definition must be offered",
      );
      const name = index === 0 ? "WebSearch" : "WebFetch";
      const args =
        index === 0
          ? { query: query, num_results: 3 }
          : {
              url: fetchUrl,
              prompt: "Read the actual official asyncio documentation.",
            };
      const delta =
        index < toolCalls
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id:
                    index === 0
                      ? searchCallId
                      : fetchCallId,
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            }
          : {
              role: "assistant",
              content:
                bundled ? "Owned bundled source query completed." : "Owned native default search and HTTPS reading completed.",
            };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        "data: " +
          JSON.stringify({
            choices: [{ index: 0, delta, finish_reason: null }],
          }) +
          "\n\ndata: " +
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: index < toolCalls ? "tool_calls" : "stop",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    } catch (error) {
      fixtureFailure = error;
      response.writeHead(400);
      response.end("Owned fixture rejected request");
    }
  });
  return {server, get requests(){return requests;},get failure(){return fixtureFailure;},get observations(){return observations;}};
}
