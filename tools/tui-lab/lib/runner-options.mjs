import {
  expandCommandTemplateForPlatform,
  platformShell,
  quoteForPlatform,
} from "./platform-adapter.mjs";

export const DEFAULT_MESSAGE =
  "Run the complete KCoder TUI automation scenario with user input, model thinking, tool calls, tool results, long counted output, and a final response.";
export const DEFAULT_SECOND_MESSAGE =
  "Regular second-turn test: confirm that input and responses continue after the previous turn ends.";

export function parseArgs(argv, { defaultWorkspaceTemplate }) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "run";
  const rest = command === argv[0] ? argv.slice(1) : argv;
  const options = {
    command,
    scenario: "full-turn",
    description: "",
    message: DEFAULT_MESSAGE,
    secondMessage: DEFAULT_SECOND_MESSAGE,
    steerAfterTool: false,
    out: "",
    workspaceTemplate: defaultWorkspaceTemplate,
    cols: 100,
    rows: 32,
    timeoutMs: 180000,
    recordSeconds: 30,
    sampleFps: 1,
    videoFps: 6,
    streamDelayMs: command === "streaming-scrollbar" ? 80 : 0,
    historyPath: "",
    historyWorkspacePath: "",
    fallbackHistoryPath: "",
    dragDurationMs: 980,
    dragSamples: 14,
    sendMessage: false,
    headless: command !== "open",
    softwareWebgl: false,
    outlineInline: false,
    outlineStreaming: false,
    copyInline: false,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = () => {
      const next = rest[++i];
      if (next === undefined) throw new Error(`missing value for ${arg}`);
      return next;
    };
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--command":
        options.commandOverride = value();
        break;
      case "--description":
        options.description = value();
        break;
      case "--message":
        options.message = value();
        break;
      case "--second-message":
        options.secondMessage = value();
        break;
      case "--steer-after-tool":
        options.steerAfterTool = true;
        break;
      case "--out":
        options.out = value();
        break;
      case "--workspace-template":
        options.workspaceTemplate = value();
        break;
      case "--scenario":
        options.scenario = value();
        break;
      case "--cols":
        options.cols = Number.parseInt(value(), 10);
        break;
      case "--rows":
        options.rows = Number.parseInt(value(), 10);
        break;
      case "--timeout-ms":
        options.timeoutMs = Number.parseInt(value(), 10);
        break;
      case "--record-seconds":
        options.recordSeconds = Number.parseFloat(value());
        break;
      case "--sample-fps":
        options.sampleFps = Number.parseFloat(value());
        break;
      case "--video-fps":
        options.videoFps = Number.parseFloat(value());
        break;
      case "--stream-delay-ms":
        options.streamDelayMs = Number.parseInt(value(), 10);
        break;
      case "--history":
        options.historyPath = value();
        break;
      case "--history-workspace":
        options.historyWorkspacePath = value();
        break;
      case "--fallback-history":
        options.fallbackHistoryPath = value();
        break;
      case "--drag-duration-ms":
        options.dragDurationMs = Number.parseInt(value(), 10);
        break;
      case "--drag-samples":
        options.dragSamples = Number.parseInt(value(), 10);
        break;
      case "--send-message":
        options.sendMessage = true;
        break;
      case "--headed":
        options.headless = false;
        break;
      case "--headless":
        options.headless = true;
        break;
      case "--software-webgl":
        options.softwareWebgl = true;
        break;
      case "--outline-inline":
        options.outlineInline = true;
        break;
      case "--outline-streaming":
        options.outlineStreaming = true;
        break;
      case "--copy-inline":
        options.copyInline = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  validateOptions(options);
  if (options.command === "lsp-diagnostics") {
    if (options.scenario === "full-turn") options.scenario = "lsp-diagnostics";
    if (options.message === DEFAULT_MESSAGE) {
      options.message =
        "Create a Python file with a type error and confirm the write tool returns real pyright LSP diagnostics.";
    }
  }
  if (options.command === "ocr-review") {
    if (options.scenario === "full-turn") options.scenario = "ocr-review";
    if (options.message === DEFAULT_MESSAGE) {
      options.message =
        "Run OCR preview for this demo git diff and summarize whether the model can see the tool result.";
    }
  }
  if (options.command === "targeted-subagent-steer") {
    if (options.scenario === "full-turn") options.scenario = "subagent-trace";
    if (options.message === DEFAULT_MESSAGE) {
      options.message =
        "app-server-background-subagent tui-lab-targeted-subagent-steer";
    }
  }
  if (options.command === "targeted-subagent-stop") {
    if (options.scenario === "full-turn") options.scenario = "subagent-trace";
    if (options.message === DEFAULT_MESSAGE) {
      options.message =
        "app-server-background-subagent tui-lab-targeted-subagent-stop";
    }
  }
  return options;
}

export function browserLaunchOptions(options) {
  return {
    headless: options.headless,
    // Enable SwiftShader only when explicitly selected, retaining the default graphics backend to expose environment differences.
    ...(options.softwareWebgl
      ? {
          args: [
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
          ],
        }
      : {}),
  };
}

function validateOptions(options) {
  if (!Number.isFinite(options.cols) || options.cols < 20)
    throw new Error("--cols must be a number >= 20");
  if (!Number.isFinite(options.rows) || options.rows < 10)
    throw new Error("--rows must be a number >= 10");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000)
    throw new Error("--timeout-ms must be a number >= 1000");
  if (!Number.isFinite(options.recordSeconds) || options.recordSeconds < 1)
    throw new Error("--record-seconds must be a number >= 1");
  if (
    !Number.isFinite(options.sampleFps) ||
    options.sampleFps <= 0 ||
    options.sampleFps > 10
  )
    throw new Error("--sample-fps must be a number in (0, 10]");
  if (
    !Number.isFinite(options.videoFps) ||
    options.videoFps <= 0 ||
    options.videoFps > 30
  )
    throw new Error("--video-fps must be a number in (0, 30]");
  if (
    !Number.isFinite(options.streamDelayMs) ||
    options.streamDelayMs < 0 ||
    options.streamDelayMs > 2000
  )
    throw new Error("--stream-delay-ms must be a number in [0, 2000]");
  if (
    !Number.isFinite(options.dragDurationMs) ||
    options.dragDurationMs < 100 ||
    options.dragDurationMs > 60000
  )
    throw new Error("--drag-duration-ms must be a number in [100, 60000]");
  if (
    !Number.isFinite(options.dragSamples) ||
    options.dragSamples < 2 ||
    options.dragSamples > 240
  )
    throw new Error("--drag-samples must be a number in [2, 240]");
}

export function defaultCommandParts(options) {
  const workspaceArgs = options.workspaceDir
    ? ["--cwd", options.workspaceDir]
    : [];
  const orchestrateArgs =
    options.scenario === "orchestrate" ||
    options.scenario === "orchestrate-control"
      ? ["--orchestrate"]
      : [];
  return {
    file: "cargo",
    args: [
      "run",
      "-p",
      "kcoder_cli",
      "--bin",
      "kcoder",
      "--",
      ...workspaceArgs,
      ...orchestrateArgs,
      "tui-dev",
      "--scenario",
      options.scenario,
    ],
  };
}

export function ptyCommand(options, runtime = {}) {
  if (options.commandOverride) {
    const shell = platformShell(
      runtime.platform || process.platform,
      runtime.env || process.env,
    );
    return {
      file: shell.file,
      args: [
        ...shell.commandArgs,
        expandCommandTemplate(options.commandOverride, options, runtime),
      ],
    };
  }
  return defaultCommandParts(options);
}

export function defaultCommandString(options, runtime = {}) {
  if (options.commandOverride)
    return expandCommandTemplate(options.commandOverride, options, runtime);
  const { file, args } = defaultCommandParts(options);
  return [file, ...args].map((value) => shellQuote(value, runtime)).join(" ");
}

export function expandCommandTemplate(command, options, runtime = {}) {
  return expandCommandTemplateForPlatform(
    command,
    {
      workspace: options.workspaceDir || "",
      runDir: options.runDir || "",
      repoRoot: runtime.repoRoot || options.repoRoot || "",
    },
    runtime.platform || process.platform,
  );
}

export function shellQuote(value, runtime = {}) {
  return quoteForPlatform(value, runtime.platform || process.platform);
}
