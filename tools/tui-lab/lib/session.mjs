import process from "node:process";
import { ptyCommand } from "./runner-options.mjs";
import {
  delayedSpawn,
  configEnvironment,
  terminalPreambleForPlatform,
  requestGracefulPtyStop,
  terminateProcessWithoutConsoleAttach,
} from "./platform-adapter.mjs";
import { nodeModulesBin, repoRoot, toolRoot } from "./runtime-paths.mjs";
import path from "node:path";
import * as pty from "node-pty";
import { createServer } from "node:http";
import { renderTerminalPage } from "./terminal-page.mjs";
import { readFile } from "node:fs/promises";
import { formatError } from "./runtime-artifacts.mjs";
import { existsSync, createReadStream } from "node:fs";
import { WebSocketServer } from "ws";

export function browserAttachDelaySeconds() {
  const raw = process.env.KCODER_TUI_LAB_ATTACH_DELAY_MS || "700";
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return parsed / 1000;
}

export async function startSession(options) {
  const { file, args } = ptyCommand(options);
  const attachDelaySeconds = browserAttachDelaySeconds();
  const delayed =
    attachDelaySeconds > 0
      ? delayedSpawn(
          file,
          args,
          attachDelaySeconds,
          process.platform,
          process.env,
        )
      : { file, args };
  const spawnedFile = delayed.file;
  const spawnedArgs = delayed.args;
  const configHome = options.configHome || options.runDir || "";
  // TUI Lab validates real terminal colors; NO_COLOR is suitable only for plain-text logs and must not reach TUI child processes.
  const { NO_COLOR: _noColor, ...inheritedEnv } = process.env;
  const env = {
    ...inheritedEnv,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    PATH: `${nodeModulesBin}${path.delimiter}${process.env.PATH || ""}`,
    ...configEnvironment(configHome, process.platform),
    RUST_LOG:
      process.env.RUST_LOG ||
      (options.scenario === "lsp-diagnostics"
        ? "warn,kcoder_tools::lsp=info"
        : "warn"),
    KCODER_TUI_LAB: "1",
    KCODER_TUI_LAB_RUN_DIR: options.runDir || "",
    KCODER_TUI_LAB_WORKSPACE: options.workspaceDir || "",
    KCODER_TUI_LAB_REQUEST_DIR: options.requestsDir || "",
    KCODER_TUI_LAB_CLIPBOARD_IMAGE_PATH:
      options.clipboardImageFixturePath || "",
    KCODER_TUI_LAB_STREAM_DELAY_MS: String(options.streamDelayMs || 0),
    KCODER_TUI_LAB_TEXT_CHUNK_CHARS:
      options.tuiLabMode === "targeted-subagent-steer"
        ? "2000"
        : options.scenario === "markdown-streaming"
          ? "1024"
          : options.tuiLabMode === "tail-menu"
            ? "32"
            : "",
    KCODER_TUI_LAB_SUBAGENT_STREAM_DELAY_MS:
      options.tuiLabMode === "targeted-subagent-steer" ||
      options.tuiLabMode === "targeted-subagent-stop"
        ? process.env.KCODER_TUI_LAB_SUBAGENT_STREAM_DELAY_MS || "1500"
        : options.scenario === "orchestrate-control"
          ? process.env.KCODER_TUI_LAB_SUBAGENT_STREAM_DELAY_MS || "25"
          : process.env.KCODER_TUI_LAB_SUBAGENT_STREAM_DELAY_MS || "",
    KCODER_TUI_LAB_FULL_TURN_TOOL_DELAY_MS: options.steerAfterTool
      ? "10000"
      : "",
    KCODER_TUI_INPUT_TRACE:
      options.tuiLabMode === "paste"
        ? path.join(options.runDir, "input-source-trace.log")
        : "",
    KCODER_LSP_ENABLED:
      options.scenario === "lsp-diagnostics"
        ? "1"
        : process.env.KCODER_LSP_ENABLED || "",
    KCODER_LSP_TIMEOUT_MS:
      options.scenario === "lsp-diagnostics"
        ? "10000"
        : process.env.KCODER_LSP_TIMEOUT_MS || "",
  };
  delete env.KCODER_HISTORY_DIR;
  if (options.tuiLabMode === "copy-view") {
    env.SSH_CONNECTION = "tui-lab-osc52";
    delete env.TMUX;
    delete env.STY;
  }
  if (options.externalEditorCommand) {
    env.VISUAL = options.externalEditorCommand;
    env.EDITOR = options.externalEditorCommand;
    env.KCODER_TUI_LAB_EDITOR_MARKER = options.externalEditorMarker;
  }

  const ptyProcess = pty.spawn(spawnedFile, spawnedArgs, {
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: repoRoot,
    env,
  });

  let backlog = "";
  let ptyLog = "";
  let exitInfo = null;
  let exited = false;
  const diagnostics = [];
  const exitPromise = new Promise((resolve) => {
    ptyProcess.onExit((event) => {
      exited = true;
      exitInfo = {
        exitCode: event.exitCode,
        signal: event.signal,
        at: new Date().toISOString(),
      };
      diagnostics.push({ type: "exit", ...exitInfo });
      resolve(exitInfo);
    });
  });
  const clients = new Set();
  ptyProcess.onData((data) => {
    ptyLog += data;
    backlog += data;
    if (backlog.length > 400000) {
      backlog = backlog.slice(-250000);
    }
    for (const ws of clients) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }
  });

  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
    if (requestUrl.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderTerminalPage(options));
      return;
    }
    if (requestUrl.pathname === "/viewport-diagnostics") {
      const tracePath = path.join(options.runDir || "", "viewport-trace.jsonl");
      const afterSequence = Math.max(
        0,
        Number.parseInt(requestUrl.searchParams.get("after") || "0", 10) || 0,
      );
      void readFile(tracePath, "utf8")
        .catch((error) => {
          if (error?.code === "ENOENT") return "";
          throw error;
        })
        .then((content) => {
          const events = content
            .split("\n")
            .filter(Boolean)
            .flatMap((line) => {
              try {
                return [JSON.parse(line)];
              } catch {
                // Rust may still be writing the final line; the sampler consumes complete JSONL records only.
                return [];
              }
            });
          const inputs = events.filter((event) => event.phase === "input");
          const commits = events.filter((event) => event.phase === "commit");
          const sequencedEvents = events.filter(
            (event) =>
              Number.isSafeInteger(event.sequence) &&
              event.sequence > afterSequence,
          );
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(
            JSON.stringify({
              inputCount: inputs.length,
              commitCount: commits.length,
              afterSequence,
              latestSequence: events.at(-1)?.sequence || 0,
              events: sequencedEvents,
              latestInput: inputs.at(-1) || null,
              latestCommit: commits.at(-1) || null,
            }),
          );
        })
        .catch((error) => {
          res.writeHead(500, {
            "content-type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify({ error: formatError(error) }));
        });
      return;
    }
    const staticMap = new Map([
      [
        "/xterm.css",
        path.join(
          toolRoot,
          "node_modules",
          "@xterm",
          "xterm",
          "css",
          "xterm.css",
        ),
      ],
      [
        "/xterm.js",
        path.join(
          toolRoot,
          "node_modules",
          "@xterm",
          "xterm",
          "lib",
          "xterm.js",
        ),
      ],
      [
        "/addon-fit.js",
        path.join(
          toolRoot,
          "node_modules",
          "@xterm",
          "addon-fit",
          "lib",
          "addon-fit.js",
        ),
      ],
      [
        "/addon-webgl.js",
        path.join(
          toolRoot,
          "node_modules",
          "@xterm",
          "addon-webgl",
          "lib",
          "addon-webgl.js",
        ),
      ],
    ]);
    const filePath = staticMap.get(requestUrl.pathname);
    if (!filePath || !existsSync(filePath)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": filePath.endsWith(".css")
        ? "text/css"
        : "application/javascript",
    });
    createReadStream(filePath).pipe(res);
  });

  const wss = new WebSocketServer({ server, path: "/pty" });
  wss.on("connection", (ws) => {
    clients.add(ws);
    const terminalPreamble = terminalPreambleForPlatform(
      process.platform,
      options.tuiLabMode,
    );
    if (terminalPreamble) {
      ws.send(terminalPreamble);
    }
    if (backlog) {
      ws.send(backlog);
    }
    ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type === "input") {
        try {
          ptyProcess.write(message.data);
        } catch (error) {
          diagnostics.push({
            type: "write-error",
            at: new Date().toISOString(),
            error: formatError(error),
          });
        }
      } else if (message.type === "resize") {
        const cols = Number.parseInt(message.cols, 10);
        const rows = Number.parseInt(message.rows, 10);
        if (
          Number.isFinite(cols) &&
          Number.isFinite(rows) &&
          cols > 0 &&
          rows > 0
        ) {
          try {
            if (!exited) {
              ptyProcess.resize(cols, rows);
            } else {
              diagnostics.push({
                type: "resize-after-exit",
                at: new Date().toISOString(),
                cols,
                rows,
                exitInfo,
              });
            }
          } catch (error) {
            diagnostics.push({
              type: "resize-error",
              at: new Date().toISOString(),
              cols,
              rows,
              error: formatError(error),
            });
          }
        }
      }
    });
    ws.on("close", () => clients.delete(ws));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;
  const stop = async () => {
    try {
      const stoppedGracefully = await requestGracefulPtyStop(
        ptyProcess,
        exitPromise,
        () => exited,
        process.platform,
      );
      if (!stoppedGracefully && !exited) {
        if (process.platform === "win32") {
          const terminated = terminateProcessWithoutConsoleAttach(
            ptyProcess.pid,
          );
          diagnostics.push({
            type: terminated
              ? "process-terminated-without-console-attach"
              : "kill-skipped-after-missed-exit",
            at: new Date().toISOString(),
            pid: ptyProcess.pid,
          });
        } else {
          ptyProcess.kill();
        }
      }
    } catch {
      // Best-effort shutdown only.
    }
    for (const ws of clients) {
      ws.terminate();
    }
    wss.close();
    server.closeAllConnections?.();
    await Promise.race([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  };

  return {
    url,
    stop,
    ptyProcess,
    exitPromise,
    getExitInfo: () => exitInfo,
    getPtyLog: () => ptyLog,
    getDiagnostics: () => diagnostics.slice(),
  };
}
