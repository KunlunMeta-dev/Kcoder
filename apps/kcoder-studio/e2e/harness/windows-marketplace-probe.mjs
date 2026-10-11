import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  rm,
} from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, sep, toNamespacedPath } from "node:path";
import { createServer } from "node:http";
const bin = process.argv[2];
const mcpPlugin = process.argv[4] || "exa";
assert.ok(["exa", "context7", "playwright"].includes(mcpPlugin));
assert.equal(process.platform, "win32");
assert.ok(process.argv[3], "An owned artifact directory is required");
const root = await mkdtemp(join(process.argv[3], "marketplace "));
const deadline = Date.now() + 180000;
await mkdir(join(root, "workspace"));
await mkdir(join(root, "temp"));
if (mcpPlugin === "playwright")
  assert.ok(
    process.argv[5],
    "An explicit bundled Chrome executable is required",
  );
const settingsPath = join(root, "settings.json");
const settings = {
  active_provider: "test",
  permission_mode: "yolo",
  max_retries: 0,
  providers: {
    test: {
      api_format: "openai_chat_completions",
      endpoint: "http://127.0.0.1:1/v1",
      default_model: "test",
      authentication: { mode: "none" },
      context_window_tokens: 128000,
      max_output_tokens: 4096,
      output_headroom_tokens: 4096,
    },
  },
};
let activeToolName;
let activeToolArguments;
let actualToolResult = "";
let modelRequests = 0;
const fixture = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
    if (body.length > 4 * 1024 * 1024) request.destroy();
  });
  request.on("end", () => {
    if (request.url === "/browser-fixture") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        "<html><title>MCP fixture</title><body><h1>WINDOWS_MARKETPLACE_BROWSER_OK</h1></body></html>",
      );
      return;
    }
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "test", object: "model" }] }));
      return;
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    if (++modelRequests > 3 || !activeToolName) {
      response.writeHead(400);
      response.end();
      return;
    }
    const toolResponse = payload.messages?.findLast(
      (message) => message.role === "tool",
    );
    if (toolResponse)
      actualToolResult =
        typeof toolResponse.content === "string"
          ? toolResponse.content
          : JSON.stringify(toolResponse.content);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = {
      id: "marketplace-live-call",
      object: "chat.completion.chunk",
      created: 1,
      model: "test",
    };
    const delta = toolResponse
      ? { role: "assistant", content: "MCP_REAL_TOOL_COMPLETED" }
      : {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "marketplace-call",
              type: "function",
              function: {
                name: activeToolName,
                arguments: JSON.stringify(activeToolArguments),
              },
            },
          ],
        };
    response.write(
      `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: toolResponse ? "stop" : "tool_calls" }] })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
settings.providers.test.endpoint = `http://127.0.0.1:${fixture.address().port}/v1`;
await writeFile(settingsPath, JSON.stringify(settings));
const children = [];
function start(scenario) {
  const args = [
    "--settings-file",
    settingsPath,
    "--cwd",
    join(root, "workspace"),
    "app-server",
    ...(scenario ? ["--scenario", scenario] : []),
  ];
  const child = spawn(bin, args, {
    cwd: join(root, "workspace"),
    env: {
      ...process.env,
      KCODER_CONFIG_DIR: join(root, "config"),
      CONTEXT7_API_KEY: "",
      ...(mcpPlugin === "playwright"
        ? {
            HOME: root,
            USERPROFILE: root,
            APPDATA: join(root, "appdata"),
            LOCALAPPDATA: join(root, "localappdata"),
            TEMP: join(root, "temp"),
            TMP: join(root, "temp"),
            NPM_CONFIG_CACHE: join(root, "npm-cache"),
            NPM_CONFIG_USERCONFIG: join(root, "npmrc"),
            NPM_CONFIG_GLOBALCONFIG: join(root, "global-npmrc"),
            PLAYWRIGHT_MCP_EXECUTABLE_PATH: process.argv[5],
            PLAYWRIGHT_MCP_HEADLESS: "1",
            PLAYWRIGHT_MCP_ISOLATED: "1",
            PLAYWRIGHT_MCP_USER_DATA_DIR: join(root, "browser-profile"),
            PLAYWRIGHT_MCP_OUTPUT_DIR: join(root, "browser-output"),
          }
        : {}),
      KCODER_TUI_LAB_STREAM_DELAY_MS: "0",
    },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const messages = [];
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
    stderr = stderr.slice(-4096);
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      messages.push(JSON.parse(line));
    } catch {}
  });
  async function wait(predicate) {
    const end = deadline;
    while (Date.now() < end) {
      const i = messages.findIndex(predicate);
      if (i >= 0) return messages.splice(i, 1)[0];
      if (child.exitCode !== null)
        throw Error(`exit ${child.exitCode}: ${stderr.slice(-1200)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    throw Error(`timeout: ${stderr.slice(-1200)}`);
  }
  let id = 0;
  return {
    child,
    diagnostics: () => stderr,
    wait,
    async request(method, params = {}) {
      const next = ++id;
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: next, method, params }) + "\n",
      );
      const res = await wait((m) => m.id === next);
      assert.equal(res.error, undefined, JSON.stringify(res.error));
      return res.result;
    },
  };
}
async function init(s) {
  await s.request("initialize", {
    protocolVersion: "2026-07-27",
    clientInfo: { name: "windows-native-smoke", version: "1" },
  });
}

const marketplaceSource = process.env.KCODER_TEST_MARKETPLACE_SOURCE;
if (!marketplaceSource) {
  console.log("KCODER_TEST_MARKETPLACE_SOURCE not set; skipping real marketplace download probe.");
  process.exit(0);
}

try {
  const s = start();
  await init(s);
  console.log("Starting real marketplace download");
  const added = await s.request("marketplace/add", {
    source: marketplaceSource,
  });
  console.log("Marketplace downloaded:", added.marketplaceName);
  for (const name of ["frontend-design", mcpPlugin, "ai-plugins"]) {
    try {
      const result = await s.request("plugin/install", {
        marketplaceName: added.marketplaceName,
        pluginName: name,
      });
      assert.ok(
        Array.isArray(result.plugin.components),
        "Installed component inventory missing",
      );
      console.log(
        "INSTALL",
        name,
        result.plugin.id,
        result.plugin.components.map((component) => ({
          kind: component.kind,
          name: component.name,
        })),
      );
      if (name === "frontend-design")
        assert.ok(
          result.plugin.components.some(
            (component) => component.kind === "skill",
          ),
        );
      if (
        name === mcpPlugin &&
        !result.plugin.components.some((component) => component.kind === "mcp")
      ) {
        const detail = await s.request("plugin/read", {
          pluginId: result.plugin.id,
        });
        console.log(
          "MCP inventory diagnostic:",
          JSON.stringify({
            compatibility: result.plugin.compatibility,
            diagnostics: detail.diagnostics,
          }),
        );
      }
      if (name === mcpPlugin)
        assert.ok(
          result.plugin.components.some(
            (component) => component.kind === "mcp",
          ),
        );
      if (name === "ai-plugins")
        assert.ok(
          result.plugin.components.some(
            (component) => component.kind === "hook",
          ),
        );
      if (name === "playwright") {
        assert.ok(
          toNamespacedPath(result.plugin.root)
            .toLowerCase()
            .startsWith(toNamespacedPath(root).toLowerCase() + sep),
        );
        const path = join(result.plugin.root, ".mcp.json");
        const config = JSON.parse(await readFile(path, "utf8"));
        // Configure only owned browser/cache paths; retain the marketplace's command and package arguments.
        config.playwright.env = {
          PLAYWRIGHT_MCP_EXECUTABLE_PATH: process.argv[5],
          PLAYWRIGHT_MCP_HEADLESS: "1",
          PLAYWRIGHT_MCP_USER_DATA_DIR: join(root, "browser-profile"),
          PLAYWRIGHT_MCP_OUTPUT_DIR: join(root, "browser-output"),
          NPM_CONFIG_CACHE: join(root, "npm-cache"),
          NPM_CONFIG_USERCONFIG: join(root, "npmrc"),
          NPM_CONFIG_GLOBALCONFIG: join(root, "global-npmrc"),
          TEMP: join(root, "temp"),
          TMP: join(root, "temp"),
        };
        await writeFile(path, JSON.stringify(config));
      }
      const t = await s.request("thread/start");
      const skills = await s.request("device/execute", {
        command_key: "ls_skills",
        threadId: t.thread.id,
      });
      const catalog = await s.request("tools/catalog", {
        threadId: t.thread.id,
      });
      console.log("SKILL FOUND", name, JSON.stringify(skills).includes(name));
      if (name === "frontend-design")
        assert.ok(JSON.stringify(skills).includes("frontend-design"));
      console.log(
        "MCP",
        name,
        JSON.stringify(catalog).includes(mcpPlugin),
        JSON.stringify(catalog).includes("resolve-library-id"),
      );
      if (name === mcpPlugin && !JSON.stringify(catalog).includes(mcpPlugin))
        console.log("MCP connection diagnostic:", s.diagnostics());
      if (name === mcpPlugin)
        assert.ok(
          JSON.stringify(catalog).includes(mcpPlugin),
          `${mcpPlugin} tools missing after install`,
        );
      if (name === mcpPlugin) {
        const tool = catalog.tools.find((item) =>
          (mcpPlugin === "exa"
            ? /web_search_exa/
            : mcpPlugin === "playwright"
              ? /browser_navigate/
              : /resolve[-_]library[-_]id/
          ).test(`${item.name} ${item.displayName}`),
        );
        assert.ok(tool, "The installed MCP tool was not published");
        activeToolName = tool.name;
        activeToolArguments =
          mcpPlugin === "exa"
            ? {
                query: "Python asyncio documentation",
                objective: "Find the official Python asyncio documentation",
                numResults: 2,
              }
            : mcpPlugin === "playwright"
              ? {
                  url: `http://127.0.0.1:${fixture.address().port}/browser-fixture`,
                }
              : {
                  libraryName: "react",
                  query: "Find the official React JavaScript documentation.",
                };
        await s.request("turn/start", {
          threadId: t.thread.id,
          input: [
            {
              type: "text",
              text: `Use ${mcpPlugin} to find official programming documentation.`,
            },
          ],
        });
        const completed = await s.wait(
          (message) =>
            message.method === "turn/completed" &&
            message.params.threadId === t.thread.id,
        );
        assert.equal(completed.params.turn.status, "completed");
        const expected =
          mcpPlugin === "exa"
            ? /docs\.python\.org\/3(?:\.\d+)?\/(?:library\/asyncio|howto\/a-conceptual-overview-of-asyncio)/
            : mcpPlugin === "playwright"
              ? /Page Title: MCP fixture/
              : /\/(?:websites\/react_dev|facebook\/react)/i;
        if (!expected.test(actualToolResult))
          console.log(
            "MCP result diagnostic:",
            actualToolResult.slice(0, 2000),
          );
        assert.match(
          actualToolResult,
          expected,
          "The MCP must return relevant source identifiers",
        );
        if (mcpPlugin === "playwright") {
          assert.ok(
            actualToolResult.includes(
              `http://127.0.0.1:${fixture.address().port}/browser-fixture`,
            ),
          );
          const snapshots = (await readdir(join(root, "browser-output")))
            .filter((name) => /^page-.*\.yml$/.test(name))
            .sort();
          assert.ok(
            snapshots.length > 0,
            "Playwright must persist its returned page snapshot",
          );
          assert.match(
            await readFile(
              join(root, "browser-output", snapshots.at(-1)),
              "utf8",
            ),
            /WINDOWS_MARKETPLACE_BROWSER_OK/,
          );
        }
        assert.equal(modelRequests, 2);
        console.log(
          `PASS real ${mcpPlugin} tool ${mcpPlugin === "playwright" ? "opened the owned browser fixture" : "returned official documentation"} through the Windows engine`,
        );
      }
      if (name === "ai-plugins") {
        const h = start("thinking-preview");
        await init(h);
        const ht = await h.request("thread/start");
        await h.request("turn/start", {
          threadId: ht.thread.id,
          input: [{ type: "text", text: "Hello. Reply briefly." }],
        });
        const done = await h.wait((m) => m.method === "turn/completed");
        assert.equal(done.params.turn.status, "completed");
        console.log(
          "PASS real ai-plugins UserPromptSubmit hook completed a turn",
        );
        h.child.stdin.end();
      }
      await s.request("plugin/uninstall", {
        pluginId: result.plugin.id,
        purgeData: false,
      });
      console.log("UNINSTALL", name, "ok");
    } catch (e) {
      process.exitCode = 1;
      console.log("FAIL", name, String(e));
      if (name === mcpPlugin)
        console.log("MCP connection diagnostic:", s.diagnostics());
    }
  }
} finally {
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
  for (const child of children)
    if (child.exitCode === null)
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 300,
  });
  console.log("Owned marketplace test state removed");
}
