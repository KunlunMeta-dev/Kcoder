//! Real-terminal evidence for the continuous-work status segment, control and
//! requirement submission.
//!
//! A bound work cannot be manufactured from the file system: only the native
//! app-server admits one, from a committed turn whose own `create_goal` tool
//! result activated a goal. This scenario therefore runs the product's own
//! app-server with the deterministic `goal-pro` scenario first, waits for the
//! admitted record in the private profile store, and only then resumes that
//! exact session in the TUI. Nothing here writes the work store: the store is
//! only read, and `/work pause` / `/work input` are submitted by the TUI itself.

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, readFile, readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { chromium } from "@playwright/test";
import {
  attachBrowserConsole,
  captureStep,
  formatBrowserConsole,
} from "./browser-evidence.mjs";
import {
  settleLifecycleStep,
  validateBrowserCleanup,
} from "./browser-lifecycle.mjs";
import { configEnvironment } from "./platform-adapter.mjs";
import {
  writeFailureArtifacts,
  writeJsonArtifact,
  writeStartMeta,
  writeTextArtifact,
} from "./runtime-artifacts.mjs";
import {
  browserLaunchOptions,
  defaultCommandParts,
  defaultCommandString,
  shellQuote,
} from "./runner-options.mjs";
import { createRunContext } from "./run-context.mjs";
import { repoRoot, runContextRuntime } from "./runtime-paths.mjs";
import { startSession } from "./session.mjs";
import {
  focusTerminal,
  submitTerminalLine,
  waitForTerminalText,
} from "./terminal-interaction.mjs";

/** Owned compiled binary shared by both processes; never guessed per process. */
export const WORK_BINARY_ENV = "KCODER_TUI_LAB_WORK_BINARY";
/** Deterministic mock scenario whose turn creates the goal the work binds to. */
export const WORK_SCENARIO = "goal-pro";
/** The mock replies with `create_goal` only for a prompt carrying this marker. */
export const WORK_FIXTURE_PROMPT =
  "continuous-work-fixture-request: please complete this task";
/** Shape of the footer segment: `work:<lowercase label>` plus optional ` +N`. */
export const WORK_SEGMENT_PATTERN = /^work:[a-z][a-z_-]*( \+\d+)?$/;
/**
 * The requirement this terminal appends through `/work input`. One
 * single-spaced ASCII line inside the receipt's 96-character preview bound, so
 * the printed `requirement:` field is the exact stored text, not a rewrite.
 */
export const WORK_INPUT_TEXT =
  "continuous-work-tui-input: keep this requirement for a later request";
/**
 * The receipt's own explanation of the accept path. The terminal prints it in
 * its `path:` field, so the idle and the busy decision stay distinguishable.
 */
export const WORK_INPUT_IDLE_PATH =
  "nothing claims this work and this terminal has no turn in flight";
/** Only a state the store reports as consumed may read as an application. */
export const APPLICATION_CLAIM =
  /(?:^|\s)(?:applied|settled):|\binput state: (?:applied|dispatched)\b/mu;
/** The two lines that keep a stored requirement distinct from a consumed one. */
export const NOT_CONSUMED_LINE = "not yet taken by a request";
export const DEFERRED_LINE = "still has to take into a request";
const STORE_DIRECTORY = "continuous-work.v1";
const STORE_FILE = "state.json";
const ADMISSION_TIMEOUT_MS = 120000;
const PROCESS_STOP_TIMEOUT_MS = 20000;
const FRAME_LIMIT = 4000;
const STDERR_LIMIT = 65536;
const MIN_COLS = 140;
const OBSERVATION_LINES = 9;
/**
 * The command name is rendered without its inline-code markers, so the guidance
 * is matched by its words only.
 */
export const REREAD_GUIDANCE =
  /outcome unknown, re-read with\s+\/?work observation/i;

/**
 * Fields the headless `work_observation` JSONL line and the terminal's
 * `/work observation` report project from the same stored record. Both sides
 * must describe the same work, so the comparison is field by field.
 */
export const IDENTITY_FIELDS = [
  "work_id",
  "phase",
  "revision",
  "requirements_revision",
  "waiting",
  "unconsumed_inputs",
];
/** The headless half needs a model transport and must never reach a real one. */
export const HEADLESS_MODEL = "continuous-work-observation-fixture";
/** Prompt of the headless turn; the loopback transport answers it deterministically. */
export const HEADLESS_PROMPT =
  "continuous-work-headless-observation: answer in one sentence and call no tool";
/**
 * The reply must not open with a declared task status word (`partial`,
 * `incomplete`, `blocked`), or the headless outcome would classify the run as
 * partial for a reason unrelated to this case.
 */
export const HEADLESS_REPLY =
  "The continuous work identity fixture turn completed without a tool call.";
/** The JSONL event a headless turn emits at its turn boundary. */
export const HEADLESS_OBSERVATION_TYPE = "work_observation";

const HEADLESS_TIMEOUT_MS = 180000;
const HEADLESS_STDERR_LIMIT = 65536;
const HEADLESS_EVENT_LIMIT = 4000;
const HEADLESS_BODY_LIMIT = 4 * 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value) => shellQuote(value, { platform: process.platform });

/**
 * One binary identity for the app-server and the TUI. `--command` cannot be
 * used because it would decide only the terminal half, so the operator selects
 * an owned compiled binary with [`WORK_BINARY_ENV`] instead.
 */
export async function workProcess(options) {
  const configured = process.env[WORK_BINARY_ENV] || "";
  if (configured) {
    const file = path.resolve(configured);
    const state = await stat(file).catch(() => null);
    if (!state || !state.isFile()) {
      throw new Error(`${WORK_BINARY_ENV} does not name a regular file: ${file}`);
    }
    await access(file, fsConstants.X_OK);
    return { file, prefix: [], source: WORK_BINARY_ENV, binary: file };
  }
  // Retain the tool's own default invocation so a checkout without a prebuilt
  // binary still starts both halves from the same cargo target.
  const { file, args } = defaultCommandParts({
    ...options,
    scenario: WORK_SCENARIO,
  });
  const command = args.indexOf("--");
  if (command < 0) {
    throw new Error("the default kcoder invocation has no argument separator");
  }
  return {
    file,
    prefix: args.slice(0, command + 1),
    source: "default",
    binary: null,
  };
}

/** PTY command string for the TUI half when a compiled binary was selected. */
export function workTuiCommand(options, binary) {
  if (!binary) return undefined;
  return [
    "exec",
    quote(binary),
    "--cwd",
    "{workspace}",
    "tui-dev",
    "--scenario",
    quote(options.scenario),
  ].join(" ");
}

export function appServerArgs(resolved, workspace) {
  return [
    ...resolved.prefix,
    "app-server",
    "--listen",
    "stdio://",
    "--scenario",
    WORK_SCENARIO,
    "--cwd",
    workspace,
  ];
}

/** Isolation environment for the auxiliary app-server process. */
export function appServerEnvironment(configHome, base = process.env) {
  const { NO_COLOR: _ignored, ...inherited } = base;
  return {
    ...inherited,
    ...configEnvironment(configHome, process.platform),
    RUST_LOG: base.RUST_LOG || "warn",
  };
}

/** Bounded line-delimited JSON-RPC reader for the product's own app-server. */
export function createFrameReader(onFrame) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        frame = { unparsable: line.slice(0, 200) };
      }
      onFrame(frame);
    }
  };
}

export async function waitForFrame(frames, predicate, timeoutMs, label, tail) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = frames.find(predicate);
    if (hit) return hit;
    await sleep(50);
  }
  throw new Error(`the app-server never produced ${label}\n${tail()}`);
}

function storedWorks(store) {
  const works = store?.works;
  if (!works || typeof works !== "object") return [];
  return Object.entries(works).flatMap(([key, entry]) => {
    const record = entry?.record;
    if (!record || typeof record !== "object") return [];
    return [
      {
        key,
        workId: record.identity?.workId ?? null,
        phase: record.phase ?? null,
        revision: record.revision?.revision ?? null,
        // The requirement watermark the next input must advance, and the claim
        // that decides the terminal's accept/queue path.
        requirementsRevision: record.revision?.requirementsRevision ?? null,
        activeClaim: entry.activeClaim ?? null,
        bindings: Object.keys(entry.bindings || {}),
        pendingControl: entry.pendingControl ?? null,
      },
    ];
  });
}

/** The admitted records bound to this thread; normally exactly one. */
export function boundWork(store, threadId) {
  return storedWorks(store).filter((work) => work.bindings.includes(threadId));
}

/** Read the durable store without creating, repairing or locking it. */
export async function readStore(configDir) {
  const file = path.join(configDir, STORE_DIRECTORY, STORE_FILE);
  try {
    return { file, store: JSON.parse(await readFile(file, "utf8")) };
  } catch (error) {
    if (error?.code === "ENOENT") return { file, store: null };
    throw new Error(`the continuous-work store is unreadable: ${error.message}`);
  }
}

/** The stored control receipt issued under one request id, if any. */
export function storedControlReceipt(store, requestId) {
  if (!requestId) return null;
  const operations = store?.operations;
  if (!operations || typeof operations !== "object") return null;
  for (const operation of Object.values(operations)) {
    // Stored operations are kind-tagged on disk; keep the older enum shape as a
    // fallback so a different writer representation is still readable.
    const receipt = operation?.receipt ?? operation?.Control?.receipt;
    const kind = operation?.kind;
    if (receipt && (kind === undefined || kind === "control") && receipt.requestId === requestId) {
      return {
        requestId: receipt.requestId,
        workId: receipt.work?.workId ?? null,
        action: receipt.action,
        expectedRevision: receipt.expectedRevision,
        controlEpoch: receipt.controlEpoch,
        state: receipt.state,
      };
    }
  }
  return null;
}

/**
 * The stored requirement records of one work, in store order. Only the
 * receipt's own projection is read; the requirement text lives in the payload
 * object named by `payloadRef`.
 */
export function storedInputs(store, workId) {
  const inputs = store?.inputs;
  if (!inputs || typeof inputs !== "object") return [];
  return Object.entries(inputs).flatMap(([key, entry]) => {
    const receipt = entry?.receipt;
    if (!receipt || typeof receipt !== "object") return [];
    if (!workId || receipt.work?.workId !== workId) return [];
    return [
      {
        key,
        inputId: receipt.inputId ?? null,
        requestId: receipt.requestId ?? null,
        sequence: receipt.sequence ?? null,
        kind: receipt.kind ?? null,
        state: receipt.state ?? null,
        requirementsRevision: receipt.requirementsRevision ?? null,
        payloadRef: receipt.payloadRef ?? null,
        applied: entry.applied ?? null,
        source: entry.source ?? null,
      },
    ];
  });
}

/**
 * The exact stored requirement text of one record. The payload object is a
 * sibling of the store file, named by the receipt's own `payloadRef`; a record
 * whose payload cannot be read keeps a null text and can never pass a check.
 */
export async function storedInputText(storeFile, payloadRef) {
  if (!storeFile || !payloadRef) return null;
  try {
    const bytes = await readFile(path.join(path.dirname(storeFile), payloadRef), "utf8");
    const payload = JSON.parse(bytes);
    return typeof payload?.text === "string" ? payload.text : null;
  } catch {
    return null;
  }
}

/** Locate the transcript the app-server wrote for this thread. */
export async function findTranscript(configDir, threadId) {
  const projects = path.join(configDir, "projects");
  const found = [];
  const walk = async (directory, depth) => {
    if (depth > 4) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.name === `${threadId}.jsonl`) found.push(full);
    }
  };
  await walk(projects, 0).catch(() => undefined);
  if (found.length !== 1) {
    throw new Error(
      `expected one transcript for thread ${threadId}; found ${found.length}: ${found.join(", ")}`,
    );
  }
  return found[0];
}

/** Split one rendered status line into its ` · ` segments. */
export function footerSegments(line) {
  return String(line)
    .split(" · ")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * The rendered footer line carrying the work segment. The observation report
 * also prints `work: <id>`, so only the segment shape counts here.
 */
export function workFooterLine(text) {
  const matches = String(text)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) =>
      footerSegments(line).some((segment) => WORK_SEGMENT_PATTERN.test(segment)),
    );
  return matches.length ? matches[matches.length - 1] : null;
}

/**
 * Extract the control notice the TUI printed for one `/work` action. The
 * rendered header drops the inline-code markers, so only the words are matched.
 */
export function controlNotice(text, action = "pause") {
  const lines = String(text)
    .split("\n")
    .map((line) => line.trimEnd());
  const header = /^Continuous work control\s+(\w+)\s+(.*)$/u;
  const starts = lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => {
      const match = header.exec(entry.line.trimStart());
      return Boolean(match) && match[1].replace(/`/gu, "") === action;
    });
  if (!starts.length) return null;
  const from = starts[starts.length - 1].index;
  // A notice ends at the first blank line, the next notice or the composer.
  let end = from + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (!line.trim()) break;
    if (/^[›!]/.test(line.trimStart())) break;
    if (line.trimStart().startsWith("Continuous work control")) break;
    end += 1;
  }
  return lines.slice(from, end).join("\n");
}

/**
 * Extract the requirement notice the TUI printed for one `/work input`. Every
 * outcome shares the `Continuous work requirement` header, so the printed
 * words decide whether a record, a refusal or an unknown outcome was reported.
 */
export function requirementNotice(text) {
  const lines = String(text)
    .split("\n")
    .map((line) => line.trimEnd());
  const starts = lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => /^Continuous work requirement\b/u.test(entry.line.trimStart()));
  if (!starts.length) return null;
  const from = starts[starts.length - 1].index;
  // A notice ends at the first blank line, the next notice or the composer.
  let end = from + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (!line.trim()) break;
    if (/^[›!]/.test(line.trimStart())) break;
    if (/^Continuous work\b/u.test(line.trimStart())) break;
    end += 1;
  }
  return lines.slice(from, end).join("\n");
}

/**
 * Strip the transcript pane border and padding a rendered line carries, so a
 * field value is the text the terminal actually shows.
 */
export function renderedValue(value) {
  return String(value ?? "")
    .replace(/[\s\u2502\u2503|]+$/u, "")
    .replace(/^[\s\u2502\u2503|]+/u, "")
    .trim();
}

/** One field of a printed notice, tolerating a rendered leading marker. */
export function noticeField(notice, name) {
  const match = new RegExp(
    `^[^\\p{L}\\p{N}]*${name}:\\s*(.+)$`,
    "mu",
  ).exec(String(notice || ""));
  return match ? renderedValue(match[1]) : null;
}

/** One `/work observation` report block, or null. */
export function observationReport(text) {
  const lines = String(text)
    .split("\n")
    .map((line) => line.trimEnd());
  const index = lines.findLastIndex((line) =>
    line.trimStart().startsWith("Continuous work observation"),
  );
  if (index < 0) return null;
  // The report is the header plus its fixed field lines.
  return lines.slice(index, index + OBSERVATION_LINES).join("\n");
}

/** Split `work:<label>` / `work:<label> +N` into its parts. */
export function segmentDetail(segment) {
  const match = /^work:([a-z][a-z_-]*)(?: \+(\d+))?$/.exec(String(segment || ""));
  if (!match) return null;
  return { label: match[1], pending: match[2] ? Number(match[2]) : 0 };
}

/**
 * The printed `/work observation` fields in their stored shapes. A field the
 * terminal never printed stays in `missing`: an absent line is not an agreement.
 */
export function tuiObservationFields(text) {
  const raw = {
    work_id: noticeField(text, "work"),
    phase: noticeField(text, "phase"),
    revision: noticeField(text, "revision"),
    requirements_revision: noticeField(text, "requirements revision"),
    waiting: noticeField(text, "wait"),
    unconsumed_inputs: noticeField(text, "unconsumed inputs"),
  };
  const count = raw.unconsumed_inputs;
  return {
    printed: text,
    missing: IDENTITY_FIELDS.filter((field) => raw[field] === null),
    fields: {
      ...raw,
      // The report prints the two absent shapes as words, not as gaps.
      waiting: raw.waiting === "none" ? null : raw.waiting,
      unconsumed_inputs:
        count === "unknown"
          ? null
          : /^\d+$/.test(String(count))
            ? Number(count)
            : count,
    },
  };
}

/** The stored shapes of one headless `work_observation` event. */
export function headlessObservationFields(event) {
  return {
    work_id: typeof event?.work_id === "string" ? event.work_id : null,
    phase: typeof event?.phase === "string" ? event.phase : null,
    revision: event?.revision ?? null,
    requirements_revision: event?.requirements_revision ?? null,
    waiting: event?.waiting ?? null,
    unconsumed_inputs: event?.unconsumed_inputs ?? null,
  };
}

const identityText = (value) =>
  value === null || value === undefined ? null : String(value);

/** Field-by-field identity between the terminal and the headless projection. */
export function observationIdentity(tuiObservation, headlessFields) {
  const missing = new Set(tuiObservation?.missing || []);
  const comparisons = IDENTITY_FIELDS.map((field) => {
    const tui = identityText(tuiObservation?.fields?.[field]);
    const headless = identityText(headlessFields?.[field]);
    return { field, tui, headless, equal: !missing.has(field) && tui === headless };
  });
  return {
    fields: [...IDENTITY_FIELDS],
    comparisons,
    equal: comparisons.every((entry) => entry.equal),
    missing: [...missing],
  };
}

/**
 * Only `settled` may be reported as a terminal control state. A receipt the
 * store still holds as `accepted`/`settling` must say so and wait.
 */
export function settlementHonest(section) {
  const state = String(section?.receiptState ?? "");
  const claims = Boolean(section?.claimsSettlement);
  if (state === "accepted" || state === "settling") {
    return !claims && Boolean(section?.hasSettlementWaitLine);
  }
  if (state === "settled") return claims;
  return !claims;
}

/**
 * The store's own fence for `resume`: it accepts only a work that is already
 * paused, so the printed refusal must be the code the store returns for the
 * phase it read.
 */
export function expectedResumeRefusal(storePhase) {
  if (storePhase === "paused") return null;
  if (storePhase === "stopped") {
    return "CONTINUOUS_WORK_STOPPED_REQUIRES_NEW_ACCEPTANCE";
  }
  return "CONTINUOUS_WORK_NOT_PAUSED";
}

/** One `/work resume` section against the durable outcome the store holds. */
export function resumeVerdict(section, workId, previousRequestIds = []) {
  const reasons = [];
  if (!section?.printed) reasons.push("`/work resume` printed nothing");
  if (!section?.requestId) reasons.push("`/work resume` printed no request id");
  if (section?.requestId && previousRequestIds.includes(section.requestId)) {
    reasons.push(
      `the resume reused request id ${section.requestId} instead of issuing its own`,
    );
  }
  if (section?.workId !== workId) {
    reasons.push(
      `the resume reported work ${String(section?.workId)} instead of ${String(workId)}`,
    );
  }
  if (!settlementHonest(section)) {
    reasons.push(
      "the resume notice claims a terminal state its receipt does not report",
    );
  }
  const phase = section?.storePhaseBefore;
  const expected = expectedResumeRefusal(phase);
  if (expected === null) {
    const stored = section?.storeReceipt;
    if (!stored) {
      reasons.push("the store holds no receipt for the resume it accepted");
    } else {
      if (stored.requestId !== section.requestId) {
        reasons.push("the stored receipt answers a different request id");
      }
      if (stored.state !== section.receiptState) {
        reasons.push(
          `the printed receipt state ${String(section.receiptState)} disagrees with the stored ${String(stored.state)}`,
        );
      }
      if (stored.action !== "resume") {
        reasons.push(`the stored receipt records ${String(stored.action)}`);
      }
      if (stored.workId !== workId) {
        reasons.push(`the stored receipt names work ${String(stored.workId)}`);
      }
    }
  } else {
    if (section?.storeReceipt) {
      reasons.push("the store recorded a resume its own fence refuses");
    }
    if (section?.rejectionCode !== expected) {
      reasons.push(
        `the resume reported ${String(section?.rejectionCode)} but the store refuses a ${String(phase)} work with ${expected}`,
      );
    }
    if (String(section?.storeRevisionAfter) !== String(section?.storeRevisionBefore)) {
      reasons.push(
        `a refused resume changed the stored revision from ${String(section?.storeRevisionBefore)} to ${String(section?.storeRevisionAfter)}`,
      );
    }
  }
  return { ok: reasons.length === 0, reasons, expectedRefusal: expected };
}

/** One `/work stop` section against the durable receipt the store keeps. */
export function stopVerdict(section, workId, previousRequestIds = []) {
  const reasons = [];
  const stored = section?.storeReceipt;
  if (!section?.printed) reasons.push("`/work stop` printed nothing");
  if (!section?.requestId) reasons.push("`/work stop` printed no request id");
  if (section?.requestId && previousRequestIds.includes(section.requestId)) {
    reasons.push(
      `the stop reused request id ${section.requestId} instead of issuing its own`,
    );
  }
  if (section?.workId !== workId) {
    reasons.push(
      `the stop reported work ${String(section?.workId)} instead of ${String(workId)}`,
    );
  }
  if (!stored) {
    reasons.push("the store holds no receipt for the stop it accepted");
  } else {
    if (stored.requestId !== section.requestId) {
      reasons.push("the stored receipt answers a different request id");
    }
    if (stored.state !== section.receiptState) {
      reasons.push(
        `the printed receipt state ${String(section.receiptState)} disagrees with the stored ${String(stored.state)}`,
      );
    }
    if (stored.action !== "stop") {
      reasons.push(`the stored receipt records ${String(stored.action)}`);
    }
    if (stored.workId !== workId) {
      reasons.push(`the stored receipt names work ${String(stored.workId)}`);
    }
    if (String(stored.expectedRevision) !== String(section.expectedRevision)) {
      reasons.push(
        `the printed fence ${String(section.expectedRevision)} disagrees with the stored ${String(stored.expectedRevision)}`,
      );
    }
  }
  if (!settlementHonest(section)) {
    reasons.push(
      "the stop notice claims a terminal state its receipt does not report",
    );
  }
  const before = Number(section?.storeRevisionBefore);
  const after = Number(section?.storeRevisionAfter);
  if (!Number.isInteger(before) || after !== before + 1) {
    reasons.push(
      `the recorded stop did not advance the stored revision: ${String(section?.storeRevisionBefore)} -> ${String(section?.storeRevisionAfter)}`,
    );
  }
  if (section?.supersededPrevious !== "superseded") {
    reasons.push(
      `the store did not supersede the previous control: ${String(section?.supersededPrevious)}`,
    );
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * One `/work input` submission against the durable record it appended. The
 * printed receipt must be the stored one, its `requirement:` field must be the
 * stored payload text, exactly one record may be appended, and nothing may read
 * as an application or a consumption of that requirement.
 */
export function requirementVerdict(section, workId, options = {}) {
  const { previousInputIds = [], previousRequestIds = [], repeatOf = null } = options;
  const reasons = [];
  if (!section) {
    return {
      ok: false,
      reasons: ["the TUI never submitted a requirement through `/work input`"],
    };
  }
  const printed = String(section.printed || "");
  if (!printed.trim()) return { ok: false, reasons: ["`/work input` printed nothing"] };
  if (!/^\s*Continuous work requirement recorded\b/mu.test(printed)) {
    reasons.push(
      `\`/work input\` did not record the requirement: ${String(section.header)}`,
    );
  }
  if (section.workId !== workId) {
    reasons.push(
      `the input receipt reported work ${String(section.workId)} instead of ${String(workId)}`,
    );
  }
  if (!section.inputId) reasons.push("the input receipt printed no input id");
  else if (previousInputIds.includes(section.inputId)) {
    reasons.push(`the input receipt reused input id ${section.inputId}`);
  }
  if (!section.requestId) reasons.push("the input receipt printed no request id");
  else if (previousRequestIds.includes(section.requestId)) {
    reasons.push(`the input receipt reused request id ${section.requestId}`);
  }
  const state = String(section.inputState || "");
  const sameRecord = Boolean(repeatOf && section.inputId === repeatOf.inputId);
  if (!["accepted", "queued"].includes(state)) {
    reasons.push(
      `the input receipt reports state ${state || "none"}; a stored requirement is accepted or queued, never consumed`,
    );
  }
  if (section.headerLabel && section.headerLabel !== state) {
    reasons.push(
      `the receipt header says ${section.headerLabel} but the store reported ${state}`,
    );
  }
  // The busy/idle decision is the store's own claim plus this terminal's turn.
  if (state === "accepted") {
    if (section.storeActiveClaim) {
      reasons.push("the receipt took the idle path while the store holds an active claim");
    }
    if (section.path !== WORK_INPUT_IDLE_PATH) {
      reasons.push(
        `the accepted receipt explains its path as ${String(section.path)}, not ${WORK_INPUT_IDLE_PATH}`,
      );
    }
  }
  if (state === "queued") {
    if (!section.storeActiveClaim) {
      reasons.push(
        "the receipt queued the requirement although the store holds no claim and this terminal had no turn in flight",
      );
    }
    if (!String(section.path || "").startsWith("an active durable claim")) {
      reasons.push(
        `the queued receipt explains its path as ${String(section.path)}, not a durable claim`,
      );
    }
  }
  const record = section.storeRecord || null;
  if (!record) {
    reasons.push(
      `the store holds no requirement record for the printed input id ${String(section.inputId)}`,
    );
  } else {
    if (record.requestId !== section.requestId) {
      reasons.push("the stored record answers a different request id");
    }
    if (record.kind !== "requirement") {
      reasons.push(`the stored record kind is ${String(record.kind)}`);
    }
    if (record.state !== state) {
      reasons.push(
        `the printed input state ${state || "none"} disagrees with the stored ${String(record.state)}`,
      );
    }
    if (String(record.sequence) !== String(section.sequence)) {
      reasons.push(
        `the printed sequence ${String(section.sequence)} disagrees with the stored ${String(record.sequence)}`,
      );
    }
    if (String(record.requirementsRevision) !== String(section.requirementsRevision)) {
      reasons.push(
        `the printed requirements revision ${String(section.requirementsRevision)} disagrees with the stored ${String(record.requirementsRevision)}`,
      );
    }
    if (String(record.requirementsRevision) !== String(section.workRequirementsRevisionAfter)) {
      reasons.push(
        `the record advanced the requirements revision to ${String(record.requirementsRevision)} but the work reports ${String(section.workRequirementsRevisionAfter)}`,
      );
    }
    const beforeRequirements = section.storeRequirementsRevisionBefore;
    if (
      Number.isInteger(beforeRequirements) &&
      Number.isInteger(section.workRequirementsRevisionAfter) &&
      section.workRequirementsRevisionAfter !== beforeRequirements + 1
    ) {
      reasons.push(
        `the requirement did not advance the work's requirement watermark: ${String(beforeRequirements)} -> ${String(section.workRequirementsRevisionAfter)}`,
      );
    }
    if (record.payloadText !== section.text) {
      reasons.push(
        `the stored payload ${JSON.stringify(record.payloadText)} is not the submitted requirement`,
      );
    }
    if (record.applied) {
      reasons.push("the store already carries an applied reference for the requirement");
    }
  }
  if (section.requirement !== section.text) {
    reasons.push(
      `the printed requirement preview ${JSON.stringify(section.requirement)} is not the submitted text`,
    );
  }
  if (!sameRecord) {
    if (section.newInputCount !== 1) {
      reasons.push(
        `the submission appended ${String(section.newInputCount)} input records, expected exactly one`,
      );
    }
  } else {
    if (section.newInputCount !== 0) {
      reasons.push(
        `the repeated text returned an existing record yet appended ${String(section.newInputCount)} new ones`,
      );
    }
    if (!section.existingNote) {
      reasons.push(
        "the repeated text printed the earlier input id without reporting the store's existing record",
      );
    }
  }
  if (!String(printed).includes(NOT_CONSUMED_LINE)) {
    reasons.push("the receipt does not say the requirement is not yet taken by a request");
  }
  if (!String(printed).includes(DEFERRED_LINE)) {
    reasons.push("the receipt does not say the target still has to take the requirement");
  }
  if (APPLICATION_CLAIM.test(printed) || section.claimsApplication) {
    reasons.push("the receipt claims the requirement was applied");
  }
  return { ok: reasons.length === 0, reasons };
}

/** The terminal projection and the headless line must name the same work. */
export function identityVerdict(state) {
  const headless = state?.headless || null;
  const reasons = [];
  if (!headless) {
    return {
      ok: false,
      reasons: ["the headless observation was never attempted"],
      identity: null,
    };
  }
  if (headless.lineCount !== 1) {
    reasons.push(
      `the headless invocation printed ${String(headless.lineCount)} work_observation lines, expected exactly one`,
    );
  }
  if (headless.exit?.timedOut) {
    reasons.push("the headless invocation exceeded its budget and was stopped");
  } else if (headless.exit?.error) {
    reasons.push(
      `the headless invocation could not start: ${String(headless.exit.error)}`,
    );
  } else if (headless.exit?.exitCode !== 0) {
    reasons.push(
      `the headless invocation exited ${String(headless.exit?.exitCode)}`,
    );
  }
  if (!headless.fields) {
    reasons.push("the headless invocation printed no work_observation line");
  } else if (headless.fields.work_id !== state.workId) {
    reasons.push(
      `the headless line names work ${String(headless.fields.work_id)}, not the bound ${String(state.workId)}`,
    );
  }
  const identity = observationIdentity(
    state?.observationFields,
    headless.fields,
  );
  for (const comparison of identity.comparisons) {
    if (comparison.equal) continue;
    reasons.push(
      `${comparison.field}: terminal ${comparison.tui ?? "missing"} != headless ${comparison.headless ?? "missing"}`,
    );
  }
  const detail = segmentDetail(state?.footerWorkSegment);
  if (!detail) {
    reasons.push("the footer carried no work segment to cross-check");
  } else {
    const unconsumed = headless.fields?.unconsumed_inputs;
    if (typeof unconsumed === "number" && unconsumed > 0) {
      if (detail.pending !== unconsumed) {
        reasons.push(
          `the footer shows +${detail.pending} pending inputs but the headless line reports ${unconsumed}`,
        );
      }
    } else if (detail.pending) {
      reasons.push(
        `the footer shows +${detail.pending} pending inputs but the headless line reports ${String(unconsumed)}`,
      );
    }
  }
  return { ok: reasons.length === 0, reasons, identity };
}

/**
 * Everything this run could observe. The Python evidence harness re-checks it;
 * the scenario only fails fast when it never reached a bound work.
 */
export function summarizeObservations(state) {
  const footer = state.footerLine && footerSegments(state.footerLine);
  const workSegment =
    footer?.find((segment) => WORK_SEGMENT_PATTERN.test(segment)) || null;
  const notice = state.pauseNotice;
  const unknown = state.unknownNotice;
  return {
    schemaVersion: 1,
    scenario: "work-observation",
    description: state.description,
    platform: process.platform,
    binary: state.binary,
    commands: state.commands,
    threadId: state.threadId,
    workId: state.workId,
    transcript: state.transcript,
    store: {
      file: state.storeFile,
      phase: state.storePhase,
      revision: state.storeRevision,
      bindings: state.storeBindings,
      admittedPhase: state.admittedPhase,
      controlReceipt: state.storeReceipt,
      pendingControl: state.pendingControl,
    },
    footer: {
      line: state.footerLine,
      segments: footer,
      workSegment,
      afterPauseLine: state.footerAfterPauseLine,
    },
    observation: {
      printed: state.observationText,
      workId: noticeField(state.observationText, "work"),
      phase: noticeField(state.observationText, "phase"),
      revision: noticeField(state.observationText, "revision"),
      requirementsRevision: noticeField(
        state.observationText,
        "requirements revision",
      ),
      waiting: noticeField(state.observationText, "wait"),
      unconsumedInputs: noticeField(state.observationText, "unconsumed inputs"),
      fields: state.observationFields?.fields ?? null,
      missingFields: state.observationFields?.missing ?? null,
    },
    headless: state.headless
      ? {
          command: state.headless.command,
          args: state.headless.args,
          url: state.headless.url,
          exit: state.headless.exit,
          lineCount: state.headless.lineCount,
          fields: state.headless.fields,
          event: state.headless.event,
          // The exact captured streams, so a missing line is quoted, not hinted.
          stdout: state.headless.stdout,
          stderr: state.headless.stderr,
          stderrBytes: state.headless.stderrBytes,
          stderrTruncated: state.headless.stderrTruncated,
          requests: state.headless.requests,
          identity: state.headlessIdentity,
          verdict: state.headlessVerdict
            ? { ok: state.headlessVerdict.ok, reasons: state.headlessVerdict.reasons }
            : null,
        }
      : null,
    pause: {
      printed: notice,
      header: notice ? String(notice).split("\n")[0].trim() : null,
      workId: noticeField(notice, "work"),
      requestId: noticeField(notice, "request id"),
      expectedRevision: noticeField(notice, "expected revision"),
      controlEpoch: noticeField(notice, "control epoch"),
      receiptState: noticeField(notice, "receipt state"),
      claimsSettlement: /settled:/.test(String(notice || "")),
      hasSettlementWaitLine: /submitted, waiting for settlement/.test(
        String(notice || ""),
      ),
      storeReceipt: state.storeReceipt,
    },
    resume: state.resume
      ? {
          ...state.resume,
          verdict: state.resumeVerdict
            ? { ok: state.resumeVerdict.ok, reasons: state.resumeVerdict.reasons,
                expectedRefusal: state.resumeVerdict.expectedRefusal }
            : null,
        }
      : null,
    stop: state.stop
      ? {
          ...state.stop,
          verdict: state.stopVerdict
            ? { ok: state.stopVerdict.ok, reasons: state.stopVerdict.reasons }
            : null,
        }
      : null,
    // The requirement the terminal appended, the record the store holds for it
    // and what a repeated submission of the same text did.
    input: state.input,
    unknown: {
      printed: unknown,
      header: unknown ? String(unknown).split("\n")[0].trim() : null,
      hasRereadGuidance: REREAD_GUIDANCE.test(String(unknown || "")),
      mentionsUnreadableStore:
        /could not read it, or the profile\/workspace scope could not be verified/.test(
          String(unknown || ""),
        ),
    },
    profileModes: state.profileModes,
    appServer: {
      exit: state.appServerExit,
      exitCode: state.appServerExit?.exitCode ?? null,
      timedOut: state.appServerExit?.timedOut ?? null,
      transcriptWritten: Boolean(state.transcript),
    },
    checks: state.checks,
    renderer: state.renderer,
    dimensions: state.dimensions,
  };
}

/** Fail-fast scenario-local assertions; the harness derives the case checks. */
export function workObservationChecks(state) {
  const footer = state.footerLine ? footerSegments(state.footerLine) : [];
  const pauseRequestId = noticeField(state.pauseNotice, "request id");
  const resume = resumeVerdict(
    state.resume,
    state.workId,
    pauseRequestId ? [pauseRequestId] : [],
  );
  const stop = stopVerdict(
    state.stop,
    state.workId,
    [pauseRequestId, state.resume?.requestId].filter(Boolean),
  );
  const identity = identityVerdict(state);
  return [
    {
      name: "app-server-admitted-a-bound-work",
      ok:
        Boolean(state.workId) &&
        state.storeBindings.includes(state.threadId ?? "missing"),
      detail: {
        workId: state.workId,
        threadId: state.threadId,
        bindings: state.storeBindings,
      },
    },
    {
      name: "footer-rendered-a-work-segment",
      ok: footer.some((segment) => WORK_SEGMENT_PATTERN.test(segment)),
      detail: { footerLine: state.footerLine, segments: footer },
    },
    {
      name: "work-observation-named-the-bound-work",
      ok:
        noticeField(state.observationText, "work") === state.workId &&
        noticeField(state.observationText, "phase") === state.storePhase,
      detail: {
        printed: state.observationText,
        expectedWorkId: state.workId,
        expectedPhase: state.storePhase,
      },
    },
    {
      name: "work-pause-printed-a-control-notice",
      ok: Boolean(state.pauseNotice),
      detail: { printed: state.pauseNotice },
    },
    {
      name: "headless-observation-matches-the-tui",
      ok: identity.ok,
      detail: {
        reasons: identity.reasons,
        identity: identity.identity,
        terminal: state.observationFields?.fields ?? null,
        terminalMissingFields: state.observationFields?.missing ?? null,
        headless: state.headless?.fields ?? null,
        headlessLines: state.headless?.lineCount ?? null,
        headlessExit: state.headless?.exit ?? null,
        headlessCommand: state.headless?.command ?? null,
        headlessStdout: state.headless?.stdout ?? null,
        // A missing line is reported with the exact captured stderr.
        headlessStderr: state.headless?.stderr ?? null,
        footerSegment: state.footerWorkSegment ?? null,
      },
    },
    {
      name: "work-resume-reported-the-durable-outcome",
      ok: resume.ok,
      detail: {
        reasons: resume.reasons,
        expectedRefusal: resume.expectedRefusal,
        printed: state.resume?.printed ?? null,
        requestId: state.resume?.requestId ?? null,
        expectedRevision: state.resume?.expectedRevision ?? null,
        receiptState: state.resume?.receiptState ?? null,
        rejectionCode: state.resume?.rejectionCode ?? null,
        storePhaseBefore: state.resume?.storePhaseBefore ?? null,
        storeRevisionBefore: state.resume?.storeRevisionBefore ?? null,
        storeRevisionAfter: state.resume?.storeRevisionAfter ?? null,
        storeReceipt: state.resume?.storeReceipt ?? null,
      },
    },
    {
      name: "work-stop-recorded-a-durable-receipt",
      ok: stop.ok,
      detail: {
        reasons: stop.reasons,
        printed: state.stop?.printed ?? null,
        requestId: state.stop?.requestId ?? null,
        expectedRevision: state.stop?.expectedRevision ?? null,
        controlEpoch: state.stop?.controlEpoch ?? null,
        receiptState: state.stop?.receiptState ?? null,
        storeRevisionBefore: state.stop?.storeRevisionBefore ?? null,
        storeRevisionAfter: state.stop?.storeRevisionAfter ?? null,
        storeReceipt: state.stop?.storeReceipt ?? null,
        supersededPrevious: state.stop?.supersededPrevious ?? null,
      },
    },
    {
      name: "work-input-appended-a-durable-requirement",
      ok: Boolean(state.input?.verdict?.ok),
      detail: {
        reasons: state.input?.verdict?.reasons ?? ["the input phase never ran"],
        text: state.input?.text ?? WORK_INPUT_TEXT,
        first: {
          printed: state.input?.first?.printed ?? null,
          headerLabel: state.input?.first?.headerLabel ?? null,
          inputId: state.input?.first?.inputId ?? null,
          requestId: state.input?.first?.requestId ?? null,
          sequence: state.input?.first?.sequence ?? null,
          requirementsRevision: state.input?.first?.requirementsRevision ?? null,
          inputState: state.input?.first?.inputState ?? null,
          path: state.input?.first?.path ?? null,
          storeRecord: state.input?.first?.storeRecord ?? null,
          newInputCount: state.input?.first?.newInputCount ?? null,
          storeRequirementsRevisionAfter:
            state.input?.first?.workRequirementsRevisionAfter ?? null,
          storeActiveClaim: state.input?.first?.storeActiveClaim ?? null,
        },
        repeat: {
          printed: state.input?.repeat?.printed ?? null,
          inputId: state.input?.repeat?.inputId ?? null,
          inputState: state.input?.repeat?.inputState ?? null,
          existingNote: state.input?.repeat?.existingNote ?? null,
          newInputCount: state.input?.repeat?.newInputCount ?? null,
          storeRecord: state.input?.repeat?.storeRecord ?? null,
          firstInputId: state.input?.first?.inputId ?? null,
        },
      },
    },
    {
      name: "unknown-outcome-printed-the-reread-guidance",
      ok: REREAD_GUIDANCE.test(String(state.unknownNotice || "")),
      detail: { printed: state.unknownNotice },
    },
  ];
}

/** Stop only the process this scenario started, including its own group. */
export async function stopOwnedProcess(child, timeoutMs = PROCESS_STOP_TIMEOUT_MS) {
  if (!child) return null;
  if (child.exitInfo) return child.exitInfo;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (info) => {
      if (settled) return;
      settled = true;
      resolve(info);
    };
    const kill = () => {
      if (process.platform !== "win32" && Number.isInteger(child.pid)) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // Fall back to the single owned process when the group is gone.
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may already be gone.
      }
    };
    const timer = setTimeout(() => {
      kill();
      finish({ exitCode: null, signal: "SIGKILL", timedOut: true });
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      finish({ exitCode: code, signal, timedOut: false });
    });
    try {
      // Closing stdin is the product's own shutdown path; it also ends `cargo run`.
      child.stdin?.end();
    } catch {
      // Closing an already closed pipe is not an ownership failure.
    }
  });
}

/**
 * The headless half needs a model transport and this run must never reach a
 * real provider. A loopback OpenAI-compatible endpoint keeps the product's own
 * transport, the session resume and the turn boundary real while the reply
 * stays fixed, so the emitted identity is the stored record's, not a fixture's.
 */
export async function startLoopbackProvider(
  reply = () => ({ role: "assistant", content: HEADLESS_REPLY }),
) {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      if (
        request.method !== "POST" ||
        !String(request.url).endsWith("/chat/completions")
      ) {
        requests.push({ method: request.method, url: request.url, served: false });
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("unsupported transport path");
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > HEADLESS_BODY_LIMIT) throw new Error("request body too large");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({
        method: request.method,
        url: request.url,
        served: true,
        model: body?.model ?? null,
        stream: body?.stream === true,
        messageCount: Array.isArray(body?.messages) ? body.messages.length : null,
      });
      const delta = reply(body);
      const frame = (value, reason) => ({
        id: "ct29-work-observation-fixture",
        object: "chat.completion.chunk",
        model: body?.model,
        choices: [{ index: 0, delta: value, finish_reason: reason }],
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify(frame(delta, null))}\n\ndata: ${JSON.stringify(frame({}, "stop"))}\n\ndata: [DONE]\n\n`,
      );
    } catch (error) {
      requests.push({
        method: request.method,
        url: request.url,
        error: String(error?.message || error),
      });
      try {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(String(error?.message || error));
      } catch {
        // The peer may already be gone; the request record keeps the failure.
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * The headless invocation resumes the same session in the same private profile
 * and prints one `work_observation` line at its turn boundary. `--tool-profile
 * none` keeps the turn from calling a tool, so it cannot admit a second work.
 */
export function headlessArgs(resolved, { workspace, threadId, baseUrl }) {
  return [
    ...resolved.prefix,
    "--cwd",
    workspace,
    "--json",
    "--training-mode",
    "--tool-profile",
    "none",
    "--max-retries",
    "0",
    "--provider",
    "local",
    "--local-base-url",
    baseUrl,
    "--model",
    HEADLESS_MODEL,
    "--resume",
    threadId,
    HEADLESS_PROMPT,
  ];
}

/** Isolation environment for the headless process: one profile, no inherited routing. */
export function headlessEnvironment(configHome, base = process.env) {
  const inherited = { ...base };
  for (const key of [
    "KCODER_HISTORY_DIR",
    "KCODER_PROFILE",
    "KCODER_PROVIDER",
    "KCODER_MODEL",
    "KCODER_SUMMARY_PROVIDER",
    "KCODER_SUMMARY_MODEL",
    "KCODER_RESUME",
    "KCODER_BASE_URL",
    "KCODER_LOCAL_BASE_URL",
    "KCODER_LOCAL_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
    "VLLM_BASE_URL",
    "SGLANG_BASE_URL",
    "NO_COLOR",
  ]) {
    delete inherited[key];
  }
  return {
    ...inherited,
    ...configEnvironment(configHome, process.platform),
    RUST_LOG: base.RUST_LOG || "warn",
  };
}

/** Wait for one owned process, and stop its group when it exceeds its budget. */
export function waitForProcessExit(child, timeoutMs) {
  if (child.exitInfo) return Promise.resolve(child.exitInfo);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (info) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(info);
    };
    const timer = setTimeout(() => {
      try {
        if (process.platform !== "win32" && Number.isInteger(child.pid)) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // The process may already be gone.
      }
      finish({ exitCode: null, signal: "SIGKILL", timedOut: true });
    }, timeoutMs);
    child.once("error", (error) => {
      // A spawn failure never produces a process, so it is a terminal result of
      // this invocation rather than something to wait out.
      if (child.pid !== undefined) return;
      finish({
        exitCode: null,
        signal: null,
        timedOut: false,
        error: String(error?.message || error),
      });
    });
    child.once("exit", (code, signal) =>
      finish({ exitCode: code, signal, timedOut: false }),
    );
  });
}

/** Run one headless turn on the bound session and capture its identity line. */
export async function runHeadlessObservation({
  resolved,
  workspace,
  configHome,
  threadId,
  artifacts,
  trace,
}) {
  const provider = await startLoopbackProvider();
  const args = headlessArgs(resolved, {
    workspace,
    threadId,
    baseUrl: provider.url,
  });
  const command = [resolved.file, ...args].map(quote).join(" ");
  const events = [];
  const rawStdout = [];
  const stderr = [];
  let stderrLength = 0;
  let stderrTruncated = false;
  const child = spawn(resolved.file, args, {
    cwd: workspace,
    env: headlessEnvironment(configHome),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.exitInfo = null;
  child.once("exit", (code, signal) => {
    child.exitInfo = { exitCode: code, signal, at: new Date().toISOString() };
  });
  child.on("error", (error) => {
    stderr.push(`spawn error: ${error.message}\n`);
  });
  child.stdout.on("data", (chunk) => {
    if (rawStdout.length < HEADLESS_EVENT_LIMIT) rawStdout.push(chunk.toString("utf8"));
  });
  child.stdout.on(
    "data",
    createFrameReader((frame) => {
      if (events.length < HEADLESS_EVENT_LIMIT) events.push(frame);
    }),
  );
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderrLength += text.length;
    if (stderr.join("").length >= HEADLESS_STDERR_LIMIT) {
      stderrTruncated = true;
      return;
    }
    stderr.push(text);
  });
  let exit;
  try {
    exit = await waitForProcessExit(child, HEADLESS_TIMEOUT_MS);
  } finally {
    await provider.close();
  }
  const observations = events.filter(
    (event) => event?.type === HEADLESS_OBSERVATION_TYPE,
  );
  const single = observations.length === 1 ? observations[0] : null;
  const result = {
    command,
    args,
    url: provider.url,
    exit,
    lineCount: observations.length,
    fields: single ? headlessObservationFields(single) : null,
    event: single,
    stdout: rawStdout.join(""),
    stderr: stderr.join(""),
    stderrBytes: stderrLength,
    stderrTruncated,
    requests: provider.requests,
  };
  trace.push({
    name: "headless-observation",
    at: new Date().toISOString(),
    requestId: threadId,
    lineCount: result.lineCount,
    exitCode: exit.exitCode,
    timedOut: exit.timedOut,
    workId: result.fields?.work_id ?? null,
    revision: result.fields?.revision ?? null,
  });
  await writeTextArtifact(
    path.join(artifacts.dir, "headless-work-observation.jsonl"),
    result.stdout,
  );
  await writeTextArtifact(
    path.join(artifacts.dir, "headless.stderr.txt"),
    result.stderr,
  );
  return result;
}

/** Submit one `/work` action and read back what the store holds for it. */
async function captureControlAction({
  page,
  action,
  profileDir,
  threadId,
  options,
  screenshot,
  trace,
  previousRequestIds,
}) {
  const before = await readStore(profileDir);
  const beforeEntry = before.store ? boundWork(before.store, threadId)[0] : null;
  if (!beforeEntry) {
    throw new Error(
      `the bound work disappeared from the store before \`/work ${action}\``,
    );
  }
  await submitTerminalLine(page, `/work ${action}`);
  await waitForTerminalText(
    page,
    `Continuous work control ${action}`,
    options.timeoutMs,
  );
  await page.waitForTimeout(800);
  const text = await page.evaluate(() => window.tuiLab.text());
  const notice = controlNotice(text, action);
  const requestId = noticeField(notice, "request id");
  const after = await readStore(profileDir);
  const afterEntry = after.store ? boundWork(after.store, threadId)[0] : null;
  const section = {
    action,
    printed: notice,
    header: notice ? String(notice).split("\n")[0].trim() : null,
    workId: noticeField(notice, "work"),
    requestId,
    expectedRevision: noticeField(notice, "expected revision"),
    controlEpoch: noticeField(notice, "control epoch"),
    receiptState: noticeField(notice, "receipt state"),
    rejectionCode: noticeField(notice, "error"),
    claimsSettlement: /settled:/.test(String(notice || "")),
    hasSettlementWaitLine: /submitted, waiting for settlement/.test(
      String(notice || ""),
    ),
    storeReceipt: storedControlReceipt(after.store, requestId),
    storePhaseBefore: beforeEntry.phase,
    storeRevisionBefore: beforeEntry.revision,
    storePhaseAfter: afterEntry?.phase ?? null,
    storeRevisionAfter: afterEntry?.revision ?? null,
    pendingControlAfter: afterEntry?.pendingControl ?? null,
    previousRequestIds: [...previousRequestIds],
    footerLine: workFooterLine(text),
  };
  await captureStep(page, trace, `work-${action}`, screenshot);
  return section;
}

/**
 * Submit one requirement through `/work input` and read back the record the
 * store appended. The store is only read: the terminal writes the requirement,
 * this scenario records the receipt it printed and the durable copy of it.
 */
async function captureRequirementSubmission({
  page,
  profileDir,
  threadId,
  options,
  text,
  screenshot,
  trace,
  label,
  previousInputIds = [],
  previousRequestIds = [],
}) {
  const before = await readStore(profileDir);
  const beforeEntry = before.store ? boundWork(before.store, threadId)[0] : null;
  if (!beforeEntry) {
    throw new Error(
      `the bound work disappeared from the store before \`/work input\` (${label})`,
    );
  }
  const existing = before.store
    ? storedInputs(before.store, beforeEntry.workId).map((record) => record.inputId)
    : [];
  await submitTerminalLine(page, `/work input ${text}`);
  await waitForTerminalText(page, "Continuous work requirement", options.timeoutMs);
  await page.waitForTimeout(800);
  const rendered = await page.evaluate(() => window.tuiLab.text());
  const notice = requirementNotice(rendered);
  const printed = String(notice || "");
  const inputId = noticeField(notice, "input id");
  const requestId = noticeField(notice, "request id");
  // The store write happens inside the command, but the read is bounded and
  // retried so a slow filesystem cannot turn a recorded requirement into a
  // false miss. A record that never appears keeps the check failing closed.
  const deadline = Date.now() + 5000;
  let after = await readStore(profileDir);
  let inputs = after.store && beforeEntry.workId
    ? storedInputs(after.store, beforeEntry.workId)
    : [];
  while (!inputs.some((record) => record.inputId === inputId) && Date.now() < deadline) {
    await sleep(150);
    after = await readStore(profileDir);
    inputs = after.store && beforeEntry.workId
      ? storedInputs(after.store, beforeEntry.workId)
      : [];
  }
  const afterEntry = after.store ? boundWork(after.store, threadId)[0] : null;
  const known = new Set(existing);
  const newInputs = [];
  for (const record of inputs) {
    if (known.has(record.inputId)) continue;
    newInputs.push({
      ...record,
      payloadText: await storedInputText(after.file, record.payloadRef),
    });
  }
  const printedRecord = inputs.find((record) => record.inputId === inputId) ?? null;
  const storeRecord = printedRecord
    ? {
        ...printedRecord,
        payloadText: await storedInputText(after.file, printedRecord.payloadRef),
      }
    : null;
  const section = {
    label,
    text,
    submittedAt: new Date().toISOString(),
    printed: notice,
    header: notice ? String(notice).split("\n")[0].trim() : null,
    headerLabel:
      /^Continuous work requirement recorded \(([a-z_]+)\)/u.exec(
        String(notice || "").trimStart(),
      )?.[1] ?? null,
    workId: noticeField(notice, "work"),
    requirement: noticeField(notice, "requirement"),
    inputId,
    requestId,
    expectedRevision: noticeField(notice, "expected revision"),
    sequence: noticeField(notice, "sequence"),
    requirementsRevision: noticeField(notice, "requirements revision"),
    inputState: noticeField(notice, "input state"),
    path: noticeField(notice, "path"),
    existingNote: /existing record for this input id/.test(printed),
    claimsApplication: APPLICATION_CLAIM.test(printed),
    hasNotConsumedLine: printed.includes(NOT_CONSUMED_LINE),
    hasDeferredLine: printed.includes(DEFERRED_LINE),
    storePhaseBefore: beforeEntry.phase,
    storeWorkRevisionBefore: beforeEntry.revision,
    storeRequirementsRevisionBefore: beforeEntry.requirementsRevision,
    storePhaseAfter: afterEntry?.phase ?? null,
    storeWorkRevisionAfter: afterEntry?.revision ?? null,
    workRequirementsRevisionAfter: afterEntry?.requirementsRevision ?? null,
    storeActiveClaim: afterEntry?.activeClaim ?? null,
    storeRecord,
    previousInputIds: [...previousInputIds],
    previousRequestIds: [...previousRequestIds],
    inputCountBefore: existing.length,
    inputCountAfter: inputs.length,
    newInputCount: newInputs.length,
    newInputs,
    storeFile: after.file,
    footerLine: workFooterLine(rendered),
  };
  await captureStep(page, trace, `work-input-${label}`, screenshot);
  return section;
}

async function admitWorkThroughAppServer({
  resolved,
  workspace,
  configHome,
  configDir,
  trace,
}) {
  const frames = [];
  const stderr = [];
  const child = spawn(resolved.file, appServerArgs(resolved, workspace), {
    cwd: repoRoot,
    env: appServerEnvironment(configHome),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.exitInfo = null;
  child.once("exit", (code, signal) => {
    child.exitInfo = { exitCode: code, signal, at: new Date().toISOString() };
  });
  child.stdin.on("error", () => {
    // A closed pipe after exit is reported by the exit status, not here.
  });
  const tail = () => {
    const recent = frames
      .slice(-12)
      .map((frame) =>
        frame.method
          ? `${frame.method}(id=${frame.id ?? "-"})`
          : `response(id=${frame.id ?? "-"})`,
      );
    return `${frames.length} frames seen, last ${recent.join(", ") || "none"}\nstderr tail:\n${stderr.join("").slice(-4000)}`;
  };
  child.stdout.on(
    "data",
    createFrameReader((frame) => {
      if (frames.length < FRAME_LIMIT) frames.push(frame);
    }),
  );
  child.stderr.on("data", (chunk) => {
    stderr.push(chunk.toString("utf8"));
    while (stderr.join("").length > STDERR_LIMIT && stderr.length > 1) {
      stderr.shift();
    }
  });
  child.on("error", (error) => {
    stderr.push(`spawn error: ${error.message}\n`);
  });
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const result = { child, stderr, frames };
  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2026-07-27",
        clientInfo: { name: "tui-lab-work-observation", version: "1" },
        capabilities: {
          experimental: {
            continuousWorkReadV1: true,
            integrationScopeV1: true,
            taskSourcesV1: true,
          },
        },
      },
    });
    const initialized = await waitForFrame(
      frames,
      (frame) => frame.id === 1,
      ADMISSION_TIMEOUT_MS,
      "initialize",
      tail,
    );
    if (initialized?.error) {
      throw new Error(`initialize failed: ${JSON.stringify(initialized).slice(0, 600)}`);
    }
    send({ jsonrpc: "2.0", id: 2, method: "thread/start", params: {} });
    const started = await waitForFrame(
      frames,
      (frame) => frame.id === 2,
      ADMISSION_TIMEOUT_MS,
      "thread/start",
      tail,
    );
    const threadId = started?.result?.thread?.id;
    if (typeof threadId !== "string" || !threadId) {
      throw new Error(
        `thread/start returned no thread id: ${JSON.stringify(started).slice(0, 400)}`,
      );
    }
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "turn/start",
      params: {
        threadId,
        input: [{ type: "text", text: WORK_FIXTURE_PROMPT }],
      },
    });
    const accepted = await waitForFrame(
      frames,
      (frame) => frame.id === 3,
      ADMISSION_TIMEOUT_MS,
      "turn/start",
      tail,
    );
    if (accepted?.error) {
      throw new Error(`turn/start failed: ${JSON.stringify(accepted).slice(0, 600)}`);
    }
    await waitForFrame(
      frames,
      (frame) => frame.method === "turn/completed",
      ADMISSION_TIMEOUT_MS,
      "turn/completed",
      tail,
    );
    trace.push({
      name: "app-server-turn-completed",
      at: new Date().toISOString(),
      threadId,
    });
    const deadline = Date.now() + ADMISSION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const { store } = await readStore(configDir);
      const bound = store ? boundWork(store, threadId) : [];
      if (bound.length === 1) {
        trace.push({
          name: "app-server-admitted-work",
          at: new Date().toISOString(),
          workId: bound[0].workId,
          phase: bound[0].phase,
          revision: bound[0].revision,
        });
        // The admitted goal is still active, so a resuming terminal would keep
        // auto-continuing it and the long goal segment would crowd the status
        // line. Clear the goal through the product's own RPC: the durable work
        // record is a separate authority and is not removed by this call.
        send({
          jsonrpc: "2.0",
          id: 4,
          method: "thread/goal/clear",
          params: { threadId },
        });
        const cleared = await waitForFrame(
          frames,
          (frame) => frame.id === 4,
          30000,
          "thread/goal/clear",
          tail,
        );
        trace.push({
          name: "app-server-cleared-goal",
          at: new Date().toISOString(),
          error: cleared?.error ?? null,
        });
        if (cleared?.error) {
          throw new Error(
            `thread/goal/clear failed: ${JSON.stringify(cleared).slice(0, 600)}`,
          );
        }
        return { ...result, threadId, work: bound[0] };
      }
      await sleep(200);
    }
    throw new Error(`the app-server never bound a work to thread ${threadId}\n${tail()}`);
  } catch (error) {
    error.appServer = {
      tail: tail(),
      frames,
    };
    await stopOwnedProcess(child);
    throw error;
  }
}

export async function runWorkObservationScenario(options) {
  if (options.commandOverride) {
    throw new Error(
      `work-observation starts its app-server and TUI from one owned binary; set ${WORK_BINARY_ENV} instead of --command`,
    );
  }
  // The footer is one ` · `-joined status line; a wide terminal keeps every
  // segment on a single row so the segment can be compared byte for byte.
  options = { ...options, cols: Math.max(options.cols, MIN_COLS) };
  const artifacts = await createRunContext(
    options,
    "work-observation",
    runContextRuntime(),
  );
  const resolved = await workProcess({
    workspaceDir: artifacts.workspace,
  });
  const runOptions = {
    ...options,
    commandOverride: workTuiCommand(options, resolved.binary),
    runDir: artifacts.dir,
    workspaceDir: artifacts.workspace,
    requestsDir: artifacts.requestsDir,
    configHome: artifacts.configHome,
  };
  const command = defaultCommandString(runOptions);
  const serverCommand = [resolved.file, ...appServerArgs(resolved, "{workspace}")]
    .map(quote)
    .join(" ");
  const appServerLog = path.join(artifacts.dir, "app-server.log");
  const observationsFile = path.join(artifacts.dir, "work-observation.json");
  const profileDir = artifacts.configDir;
  const trace = [];
  const browserConsole = [];
  const checks = [];
  const screenshots = {
    footer: path.join(artifacts.dir, "work-footer.png"),
    pause: path.join(artifacts.dir, "work-pause.png"),
    resume: path.join(artifacts.dir, "work-resume.png"),
    input: path.join(artifacts.dir, "work-input.png"),
    inputRepeat: path.join(artifacts.dir, "work-input-repeat.png"),
    stop: path.join(artifacts.dir, "work-stop.png"),
    unknown: path.join(artifacts.dir, "work-unknown.png"),
  };
  let session;
  let browser;
  let page;
  const state = {
    description: artifacts.description,
    binary: resolved.binary,
    commands: {
      appServer: serverCommand,
      tui: command,
      binarySource: resolved.source,
      binaryEnv: resolved.binary ? WORK_BINARY_ENV : null,
    },
    threadId: null,
    workId: null,
    transcript: null,
    storeFile: null,
    storePhase: null,
    storeRevision: null,
    admittedPhase: null,
    storeBindings: [],
    storeReceipt: null,
    pendingControl: null,
    footerLine: null,
    footerAfterPauseLine: null,
    footerWorkSegment: null,
    observationText: null,
    observationFields: null,
    headless: null,
    headlessIdentity: null,
    headlessVerdict: null,
    pauseNotice: null,
    resume: null,
    resumeVerdict: null,
    input: null,
    stop: null,
    stopVerdict: null,
    unknownNotice: null,
    profileModes: {},
    appServerExit: null,
    checks,
    renderer: null,
    dimensions: null,
  };

  await writeStartMeta(artifacts, runOptions, command, "work-observation");
  try {
    // Phase 1: the product's own app-server admits the bound work.
    const admitted = await admitWorkThroughAppServer({
      resolved,
      workspace: artifacts.workspace,
      configHome: artifacts.configHome,
      configDir: profileDir,
      trace,
    });
    state.threadId = admitted.threadId;
    state.workId = admitted.work.workId;
    state.admittedPhase = admitted.work.phase;
    state.storePhase = admitted.work.phase;
    state.storeRevision = admitted.work.revision;
    state.storeBindings = admitted.work.bindings;
    state.storeFile = (await readStore(profileDir)).file;
    state.transcript = await findTranscript(profileDir, admitted.threadId);
    // The auxiliary process is stopped before the terminal opens the same store,
    // so no second writer can advance the revision under the TUI's observation.
    state.appServerExit = await stopOwnedProcess(admitted.child);
    await writeTextArtifact(appServerLog, admitted.stderr.join(""));

    // Phase 2: the same bound work is read headlessly and by the terminal. The
    // headless turn runs first, while the store is untouched, so both halves
    // observe one revision; its own session resume is the only writer left.
    state.headless = await runHeadlessObservation({
      resolved,
      workspace: artifacts.workspace,
      configHome: artifacts.configHome,
      threadId: state.threadId,
      artifacts,
      trace,
    });

    // Phase 3: the TUI resumes that exact session and renders its footer.
    session = await startSession(runOptions);
    browser = await chromium.launch(browserLaunchOptions(options));
    page = await browser.newPage({
      viewport: {
        width: Math.max(900, options.cols * 9 + 80),
        height: Math.max(560, options.rows * 18 + 80),
      },
    });
    attachBrowserConsole(page, browserConsole);
    await page.goto(session.url);
    await page.waitForFunction(() => window.tuiLab && window.tuiLab.ready, null, {
      timeout: options.timeoutMs,
    });
    await waitForTerminalText(
      page,
      "TUI dev mode is running mock scenario",
      options.timeoutMs,
    );
    await focusTerminal(page);
    await submitTerminalLine(page, `/resume ${state.transcript}`);
    await waitForTerminalText(page, "Resumed session from", options.timeoutMs);
    await submitTerminalLine(page, "/work observation");
    await waitForTerminalText(page, "Continuous work observation", options.timeoutMs);
    await page.waitForFunction(
      (pattern) =>
        window.tuiLab
          .text()
          .split("\n")
          .some((line) =>
            line
              .split(" · ")
              .map((segment) => segment.trim())
              .some((segment) => new RegExp(pattern).test(segment)),
          ),
      WORK_SEGMENT_PATTERN.source,
      { timeout: options.timeoutMs },
    );
    await page.waitForTimeout(500);
    const footerText = await page.evaluate(() => window.tuiLab.text());
    state.footerLine = workFooterLine(footerText);
    state.footerWorkSegment =
      state.footerLine &&
      footerSegments(state.footerLine).find((segment) =>
        WORK_SEGMENT_PATTERN.test(segment),
      );
    state.observationText = observationReport(footerText);
    state.observationFields = tuiObservationFields(state.observationText);
    state.headlessVerdict = identityVerdict(state);
    state.headlessIdentity = state.headlessVerdict.identity;
    await captureStep(page, trace, "work-footer", screenshots.footer);

    // Phase 4: the TUI itself submits the control against the re-read revision.
    // Still, the store is read back for every action and the printed receipt is
    // compared with its durable copy; a refusal must print the store's own code.
    const beforePause = await readStore(profileDir);
    const beforeEntry = beforePause.store
      ? boundWork(beforePause.store, state.threadId)[0]
      : null;
    if (!beforeEntry) {
      throw new Error("the bound work disappeared from the store before `/work pause`");
    }
    state.storePhase = beforeEntry.phase;
    state.storeRevision = beforeEntry.revision;
    await submitTerminalLine(page, "/work pause");
    await waitForTerminalText(page, "Continuous work control", options.timeoutMs);
    await page.waitForTimeout(800);
    const pauseText = await page.evaluate(() => window.tuiLab.text());
    state.pauseNotice = controlNotice(pauseText, "pause");
    state.footerAfterPauseLine = workFooterLine(pauseText);
    await captureStep(page, trace, "work-pause", screenshots.pause);

    const afterPause = await readStore(profileDir);
    const pauseRequestId = noticeField(state.pauseNotice, "request id");
    state.storeReceipt = storedControlReceipt(afterPause.store, pauseRequestId);
    const afterEntry = afterPause.store
      ? boundWork(afterPause.store, state.threadId)[0]
      : null;
    state.pendingControl = afterEntry?.pendingControl ?? null;
    if (afterEntry) state.storeRevision = afterEntry.revision;

    // Phase 5: the control actions each carry their own request id, and the
    // store decides whether that request is recorded or refused.
    state.resume = await captureControlAction({
      page,
      action: "resume",
      profileDir,
      threadId: state.threadId,
      options,
      screenshot: screenshots.resume,
      trace,
      previousRequestIds: [pauseRequestId].filter(Boolean),
    });
    state.resumeVerdict = resumeVerdict(
      state.resume,
      state.workId,
      [pauseRequestId].filter(Boolean),
    );

    // Phase 6: the terminal appends one requirement through `/work input` and
    // the store is re-read for the record and its own payload. A work that is
    // stopped — or that merely holds a pending stop — refuses a new requirement
    // with CONTINUOUS_WORK_STOPPED_REQUIRES_NEW_ACCEPTANCE, so this phase runs
    // before `/work stop`. The same text is submitted a second time to record
    // what the store does with a repeated requirement.
    const firstInput = await captureRequirementSubmission({
      page,
      profileDir,
      threadId: state.threadId,
      options,
      text: WORK_INPUT_TEXT,
      screenshot: screenshots.input,
      trace,
      label: "first",
      previousRequestIds: [pauseRequestId, state.resume.requestId].filter(Boolean),
    });
    const firstVerdict = requirementVerdict(firstInput, state.workId, {
      previousRequestIds: [pauseRequestId, state.resume.requestId].filter(Boolean),
    });
    const repeatInput = await captureRequirementSubmission({
      page,
      profileDir,
      threadId: state.threadId,
      options,
      text: WORK_INPUT_TEXT,
      screenshot: screenshots.inputRepeat,
      trace,
      label: "repeat",
      previousInputIds: firstInput.inputId ? [firstInput.inputId] : [],
      previousRequestIds: [
        pauseRequestId,
        state.resume.requestId,
        firstInput.requestId,
      ].filter(Boolean),
    });
    const repeatVerdict = requirementVerdict(repeatInput, state.workId, {
      previousInputIds: firstInput.inputId ? [firstInput.inputId] : [],
      previousRequestIds: [
        pauseRequestId,
        state.resume.requestId,
        firstInput.requestId,
      ].filter(Boolean),
      repeatOf: firstInput,
    });
    state.input = {
      text: WORK_INPUT_TEXT,
      first: { ...firstInput, verdict: firstVerdict },
      repeat: { ...repeatInput, verdict: repeatVerdict },
      verdict: {
        ok: firstVerdict.ok && repeatVerdict.ok,
        reasons: [...firstVerdict.reasons, ...repeatVerdict.reasons],
      },
    };

    // Phase 7: the stop closes the work for new requirements, and the store's
    // own supersession is the proof that the earlier intent is no longer
    // current; the terminal never asserts that by itself.
    state.stop = await captureControlAction({
      page,
      action: "stop",
      profileDir,
      threadId: state.threadId,
      options,
      screenshot: screenshots.stop,
      trace,
      previousRequestIds: [pauseRequestId, state.resume.requestId].filter(Boolean),
    });
    const afterStop = await readStore(profileDir);
    state.stop.supersededPrevious =
      storedControlReceipt(afterStop.store, pauseRequestId)?.state ?? null;
    state.stopVerdict = stopVerdict(
      state.stop,
      state.workId,
      [pauseRequestId, state.resume.requestId].filter(Boolean),
    );

    // Phase 8: a real unverifiable scope must produce the unknown-outcome
    // guidance. Only this run's own private profile is exposed, and it is
    // restored before the run ends.
    const before = await stat(profileDir);
    state.profileModes.before = before.mode & 0o777;
    await chmod(profileDir, 0o755);
    state.profileModes.exposed = (await stat(profileDir)).mode & 0o777;
    await submitTerminalLine(page, "/work pause");
    await waitForTerminalText(page, "work observation", options.timeoutMs);
    await page.waitForTimeout(800);
    const unknownText = await page.evaluate(() => window.tuiLab.text());
    state.unknownNotice = controlNotice(unknownText, "pause");
    await captureStep(page, trace, "work-unknown", screenshots.unknown);
    await chmod(profileDir, 0o700);
    state.profileModes.restored = (await stat(profileDir)).mode & 0o777;

    state.dimensions = await page.evaluate(() => window.tuiLab.dimensions());
    state.renderer = await page.evaluate(() => window.tuiLab.renderer);

    for (const entry of workObservationChecks(state)) checks.push(entry);
    await writeJsonArtifact(observationsFile, summarizeObservations(state));
    const text = await page.evaluate(() => window.tuiLab.text());
    await writeTextArtifact(artifacts.text, text);
    await writeTextArtifact(artifacts.ptyLog, session.getPtyLog());
    await writeTextArtifact(
      artifacts.browserConsoleLog,
      formatBrowserConsole(browserConsole),
    );
    const failed = checks.filter((check) => !check.ok).map((check) => check.name);
    const assertions = { ok: failed.length === 0, checks, failed };
    await writeJsonArtifact(artifacts.assertions, assertions);
    if (failed.length) {
      const error = new Error(
        `TUI work-observation assertions failed: ${failed.join(", ")}`,
      );
      error.assertions = assertions;
      throw error;
    }

    const completedSession = session;
    const cleanupSteps = [];
    cleanupSteps.push(
      await settleLifecycleStep("browser", () => browser.close(), 5000),
    );
    browser = null;
    cleanupSteps.push(
      await settleLifecycleStep("session", () => completedSession.stop(), 5000),
    );
    const ptyExit = await settleLifecycleStep(
      "pty-exit",
      () => completedSession.exitPromise,
      1000,
    );
    const cleanup = {
      steps: cleanupSteps,
      ptyExitObserved: ptyExit.status === "completed",
      ptyExit: ptyExit.status === "completed" ? ptyExit.value : null,
    };
    validateBrowserCleanup(cleanup);
    session = null;
    await writeJsonArtifact(artifacts.meta, {
      ok: true,
      mode: "work-observation",
      command,
      serverCommand,
      cwd: repoRoot,
      runId: artifacts.runId,
      date: artifacts.dateStamp,
      time: artifacts.timeStamp,
      description: artifacts.description,
      dateDir: artifacts.dateDir,
      runLabel: artifacts.runLabel,
      runDir: artifacts.dir,
      workspace: artifacts.workspace,
      workspaceTemplate: artifacts.workspaceTemplate,
      configHome: artifacts.configHome,
      configDir: artifacts.configDir,
      projectKey: artifacts.projectKey,
      projectDir: artifacts.projectDir,
      scenario: options.scenario,
      screenshots,
      text: artifacts.text,
      ptyLog: artifacts.ptyLog,
      browserConsoleLog: artifacts.browserConsoleLog,
      assertions: artifacts.assertions,
      observations: observationsFile,
      appServerLog,
      headlessStdout: path.join(artifacts.dir, "headless-work-observation.jsonl"),
      headlessStderr: path.join(artifacts.dir, "headless.stderr.txt"),
      headlessCommand: state.headless?.command ?? null,
      dimensions: state.dimensions,
      renderer: state.renderer,
      trace,
      cleanup,
      ptyExit: cleanup.ptyExit,
      ptyDiagnostics: completedSession.getDiagnostics(),
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "work-observation",
          ...artifacts,
          observations: summarizeObservations(state),
          assertions,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await writeFailureArtifacts({
      artifacts,
      runOptions,
      command,
      mode: "work-observation",
      session,
      page,
      browserConsole,
      trace,
      error,
    });
    if (error.appServer) {
      await writeJsonArtifact(path.join(artifacts.dir, "app-server-frames.json"), {
        frames: error.appServer.frames,
        tail: error.appServer.tail,
      });
    }
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (session) await session.stop().catch(() => {});
    // Restore the private profile mode even when the run failed early.
    if (state.profileModes.exposed === 0o755) {
      await chmod(profileDir, 0o700).catch(() => undefined);
    }
  }
}