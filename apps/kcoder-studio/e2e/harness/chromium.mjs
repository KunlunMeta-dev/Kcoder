import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { chromium } from "../../renderer/node_modules/@playwright/test/index.mjs";
import { requireExecutable, waitFor } from "./run-context.mjs";

const profileOwnersByContext = new WeakMap();
const profileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function windowSizeArgument(windowSize) {
  if (windowSize === undefined) return null;
  if (!windowSize || typeof windowSize !== "object" || Array.isArray(windowSize)) {
    throw new TypeError("windowSize must be an object with positive bounded integer width and height");
  }
  const keys = Object.keys(windowSize).sort();
  if (keys.length !== 2 || keys[0] !== "height" || keys[1] !== "width") {
    throw new TypeError("windowSize must contain only width and height");
  }
  const { width, height } = windowSize;
  if (![width, height].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 8192)) {
    throw new RangeError("windowSize width and height must be integers from 1 through 8192");
  }
  return `--window-size=${width},${height}`;
}

/** Only isolation test cases may select these fixed Chromium feature variants. */
export function sandboxedIframeIsolationArgs(mode = "browser-default") {
  if (mode === "browser-default") return [];
  if (mode === "disabled-for-test") return ["--disable-features=IsolateSandboxedIframes"];
  if (mode === "per-document") return ["--enable-features=IsolateSandboxedIframes:grouping/per-document"];
  throw new TypeError("sandboxedIframeIsolation must be browser-default, disabled-for-test, or per-document");
}

function acquireProfileOwner(context, profileName, label) {
  let owners = profileOwnersByContext.get(context);
  if (!owners) {
    owners = new Map();
    profileOwnersByContext.set(context, owners);
  }
  const current = owners.get(profileName);
  if (current) {
    throw new Error(`Chromium profile ${profileName} is already owned by process ${current.label}`);
  }
  const owner = { profileName, label, profileDir: null, released: false };
  owners.set(profileName, owner);
  return owner;
}

function releaseProfileOwner(context, owner) {
  if (owner.released) return;
  const owners = profileOwnersByContext.get(context);
  if (owners?.get(owner.profileName) !== owner) {
    throw new Error(`Chromium profile owner changed unexpectedly for ${owner.profileName}`);
  }
  owners.delete(owner.profileName);
  if (owners.size === 0) profileOwnersByContext.delete(context);
  owner.released = true;
}

function assertRunContextPath(context, path, expectedPath) {
  if (
    typeof context.runRoot !== "string" ||
    typeof context.stateDir !== "string" ||
    resolve(context.stateDir) !== resolve(context.runRoot, "state") ||
    typeof context.pathInState !== "function"
  ) {
    throw new TypeError("Chromium requires a RunContext-owned state directory");
  }
  const stateDir = resolve(context.stateDir);
  const normalized = resolve(path);
  const expected = resolve(expectedPath);
  const relativePath = relative(stateDir, normalized);
  if (normalized !== expected || !relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || relativePath.startsWith(sep)) {
    throw new Error("Chromium profile path must be derived from this RunContext state directory");
  }
  return normalized;
}

function assertPrivateDirectory(stat, path) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`unsafe Chromium profile directory: ${path}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Chromium profile directory is not owned by this user: ${path}`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`Chromium profile directory has unsafe permissions: ${path}`);
  }
}

async function ensureProfileDirectory(context, profileName) {
  const chromiumRoot = assertRunContextPath(
    context,
    context.pathInState("chromium"),
    resolve(context.stateDir, "chromium"),
  );
  const profileDir = assertRunContextPath(
    context,
    context.pathInState("chromium", `${profileName}-profile`),
    resolve(chromiumRoot, `${profileName}-profile`),
  );
  assertPrivateDirectory(await lstat(context.stateDir), context.stateDir);
  await mkdir(chromiumRoot, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(await lstat(chromiumRoot), chromiumRoot);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(await lstat(profileDir), profileDir);
  return profileDir;
}

function assertSafeActivePortFile(stat, path) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`unsafe DevToolsActivePort file: ${path}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`DevToolsActivePort is not owned by this user: ${path}`);
  }
  if ((stat.mode & 0o022) !== 0 || stat.size > 1024) {
    throw new Error(`DevToolsActivePort has unsafe permissions or size: ${path}`);
  }
}

function sameFileIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

async function openSafeActivePortFile(path) {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  assertSafeActivePortFile(before, path);

  const noFollow = constants.O_NOFOLLOW || 0;
  let file;
  try {
    file = await open(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`cannot safely open DevToolsActivePort: ${path}`, { cause: error });
  }
  try {
    const opened = await file.stat();
    assertSafeActivePortFile(opened, path);
    if (!sameFileIdentity(before, opened)) {
      throw new Error(`DevToolsActivePort changed while opening: ${path}`);
    }
    return { file, stat: opened };
  } catch (error) {
    await file.close().catch(() => undefined);
    throw error;
  }
}

async function removeStaleActivePort(path) {
  const opened = await openSafeActivePortFile(path);
  if (!opened) return;
  await opened.file.close();
  const current = await lstat(path);
  assertSafeActivePortFile(current, path);
  if (!sameFileIdentity(opened.stat, current)) {
    throw new Error(`DevToolsActivePort changed before stale endpoint removal: ${path}`);
  }
  await unlink(path);
}

async function readActivePort(path) {
  const opened = await openSafeActivePortFile(path);
  if (!opened) return null;
  try {
    const buffer = Buffer.alloc(1025);
    const { bytesRead } = await opened.file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1024) throw new Error(`DevToolsActivePort is too large: ${path}`);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    if (lines.length < 2 || lines[0] === "" || lines[1] === "") return null;
    if (lines.length !== 2) return null;
    if (!/^\d+$/.test(lines[0])) return null;
    const port = Number(lines[0]);
    const webSocketPath = lines[1];
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(webSocketPath)) {
      return null;
    }
    return { port, webSocketPath };
  } finally {
    await opened.file.close();
  }
}

function deadlineError(label, timeoutMs) {
  const error = new Error(`${label} timed out after ${timeoutMs}ms`);
  error.code = "ETIMEDOUT";
  return error;
}

function boundedOperation(operation, timeoutMs, label, { signal, onLateResolve, onLateReject, onSettle } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`${label} timeout must be a positive finite number`);
  }
  if (signal?.aborted) {
    const reason = signal.reason;
    return Promise.reject(reason instanceof Error ? reason : new Error(`${label} aborted`));
  }

  let settled = false;
  let timer = null;
  let abortHandler = null;
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolveResultValue, rejectResultValue) => {
    resolveResult = resolveResultValue;
    rejectResult = rejectResultValue;
  });
  const clearDeadline = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
    abortHandler = null;
  };
  const finish = (callback, value) => {
    if (settled) return false;
    settled = true;
    clearDeadline();
    callback(value);
    return true;
  };

  timer = setTimeout(() => finish(rejectResult, deadlineError(label, timeoutMs)), timeoutMs);
  if (signal) {
    abortHandler = () => {
      const reason = signal.reason;
      finish(rejectResult, reason instanceof Error ? reason : new Error(`${label} aborted`));
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  Promise.resolve().then(operation).then(value => {
    const late = !finish(resolveResult, value);
    if (late && onLateResolve) {
      void Promise.resolve().then(() => onLateResolve(value)).catch(() => {});
    }
    if (onSettle) {
      try { onSettle({ fulfilled: true, late }); } catch {}
    }
  }, error => {
    const late = !finish(rejectResult, error);
    if (late && onLateReject) {
      void Promise.resolve().then(() => onLateReject(error)).catch(() => {});
    }
    if (onSettle) {
      try { onSettle({ fulfilled: false, late }); } catch {}
    }
  });
  return result;
}

function recordLateCleanupFailure(context, label, phase) {
  void context.writeArtifactJson(`${label}-lifecycle-errors.json`, [{ phase, outcome: "cleanup-failed" }]).catch(() => {});
}

function closeLateResource(context, label, resource, phase, timeoutMs, closeOwned) {
  return (async () => {
    let failed = false;
    try {
      if (typeof resource?.close === "function") {
        await boundedOperation(() => resource.close(), timeoutMs, `${label} late ${phase} close`);
      }
    } catch {
      failed = true;
    } finally {
      if (closeOwned) {
        try {
          await closeOwned();
        } catch {
          failed = true;
        }
      }
    }
    if (failed) recordLateCleanupFailure(context, label, phase);
  })();
}

function closeOwnedBrowser(context, owner, child, processRecord, getBrowser, onRelease, closeTimeoutMs) {
  let browserClosed = false;
  let browserClosePending = false;
  let closePromise = null;
  let processStopped = false;

  return function close() {
    if (closePromise) return closePromise;
    if (processStopped && browserClosed) return Promise.resolve();

    const operation = (async () => {
      const errors = [];
      const browser = getBrowser();
      if (browser && !browserClosed && !browserClosePending) {
        browserClosePending = true;
        try {
          await boundedOperation(
            () => browser.close(),
            closeTimeoutMs,
            `Chromium ${owner.label} Browser.close`,
            {
              onSettle: ({ fulfilled }) => {
                browserClosePending = false;
                if (fulfilled) browserClosed = true;
              },
            },
          );
          browserClosed = true;
        } catch (error) {
          if (typeof browser.contexts === "function") {
            errors.push(error);
          }
          // Injected pre-profile lifecycle stubs expose only close(); for those
          // stubs, the exact owned process stop is the observable close result.
        }
      } else if (!browser) {
        browserClosed = true;
      }

      try {
        if (!processStopped) {
          const currentRecord = context.processes?.get(owner.label) ?? null;
          if (processRecord) {
            if (currentRecord !== processRecord) {
              throw new Error(`owned Chromium process ${owner.label} record changed; refusing cleanup without the exact owner`);
            }
            await context.stopOwned(owner.label);
            const record = context.processes?.get(owner.label);
            if (record !== processRecord || !record.stopped) {
              throw new Error(`owned Chromium process ${owner.label} has not been confirmed stopped`);
            }
            if (record.stopPromise) await record.stopPromise;
            if (child?.exitCode === null && child?.signalCode == null) {
              throw new Error(`owned Chromium process ${owner.label} has not exited`);
            }
          } else {
            if (currentRecord) {
              throw new Error(`owned Chromium process ${owner.label} record appeared unexpectedly; refusing cleanup without the exact owner`);
            }
            // RunContext always records a spawned process. This branch supports
            // injected lifecycle tests where spawnOwned and stopOwned are mocked.
            await context.stopOwned(owner.label);
            if (context.processes?.has(owner.label)) {
              throw new Error(`owned Chromium process ${owner.label} record appeared during cleanup`);
            }
          }
          processStopped = true;
          if (browserClosePending) browserClosed = true;
        }
        if (!owner.released) {
          onRelease();
        }
      } catch (error) {
        errors.push(error);
      }

      if (errors.length) {
        if (errors.length === 1) throw errors[0];
        throw new AggregateError(errors, `close Chromium ${owner.label} failed`);
      }
    })();
    closePromise = operation;
    return operation.catch(error => {
      if (closePromise === operation) closePromise = null;
      throw error;
    });
  };
}

function observePage(context, label, closed, pageErrors, page) {
  const record = (kind, message) => {
    if (closed() || pageErrors.length >= 32) return;
    pageErrors.push({ kind, message: context.redactText(String(message)).slice(0, 2000) });
  };
  page.on("pageerror", error => record("pageerror", error.stack ?? error));
  page.on("crash", () => record("crash", "renderer process crashed"));
  page.on("console", message => { if (message.type() === "error") record("console", message.text()); });
  page.on("requestfailed", request => record("requestfailed", `${new URL(request.url()).pathname}: ${request.failure()?.errorText}`));
  return page;
}

export function createChromiumLauncher({ chromiumDriver = chromium, resolveExecutable = requireExecutable, poll = waitFor } = {}) {
  if (!chromiumDriver || typeof chromiumDriver.connectOverCDP !== "function") {
    throw new TypeError("chromiumDriver must provide connectOverCDP");
  }
  if (typeof resolveExecutable !== "function" || typeof poll !== "function") {
    throw new TypeError("resolveExecutable and poll must be functions");
  }

  return async function launchChromium(context, options = {}) {
    const windowSizeArg = windowSizeArgument(options.windowSize);
    const isolationArgs = sandboxedIframeIsolationArgs(options.sandboxedIframeIsolation);
    const label = options.label || "chromium";
    const profileName = options.profileName ?? label;
    const startTimeoutMs = options.startTimeoutMs ?? 20_000;
    const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    const pageTimeoutMs = options.pageTimeoutMs ?? startTimeoutMs;
    const closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    if (typeof profileName !== "string" || !profileNamePattern.test(profileName)) {
      throw new TypeError("profileName must be a safe RunContext profile slug");
    }
    for (const [name, timeoutMs] of Object.entries({ startTimeoutMs, connectTimeoutMs, pageTimeoutMs, closeTimeoutMs })) {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new RangeError(`${name} must be a positive finite number`);
      }
    }
    const owner = acquireProfileOwner(context, profileName, label);
    let child = null;
    let close = null;
    let closeAndMark = null;
    let profileDir = null;
    let spawnAttempt = null;
    let startedAt = null;
    let startup = null;
    let startupEvidenceWritten = false;
    let onSpawnError = null;
    try {
      const executablePath = await resolveExecutable(
        options.executablePath || process.env.KCODER_E2E_CHROMIUM_BIN || "/usr/bin/chromium",
        "system Chromium",
      );
      const noSandbox = options.noSandbox ?? process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === "1";
      if (!noSandbox && process.env.KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX !== "1") {
        throw new Error(
          "UNMET_PREREQUISITE: isolated VM runs must explicitly set KCODER_E2E_CHROMIUM_NO_SANDBOX=1; sandbox-capable hosts must set KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX=1",
        );
      }

      const headless = options.headless ?? true;
      const display = options.display ?? null;
      if (typeof headless !== "boolean") throw new TypeError("headless must be a boolean");
      if (!headless) {
        if (typeof display !== "string" || !/^:\d+$/.test(display)) {
          throw new Error("headful Chromium requires an explicit owned DISPLAY such as :42");
        }
        if (options.env?.DISPLAY !== undefined && options.env.DISPLAY !== display) {
          throw new Error("headful Chromium DISPLAY must match the explicit display option");
        }
      }

      const portLabel = options.portLabel || "chromium-cdp";
      profileDir = await ensureProfileDirectory(context, profileName);
      owner.profileDir = profileDir;
      context.registerTemporaryDirectory(`${profileName} profile`, profileDir);
      const activePortFile = resolve(profileDir, "DevToolsActivePort");
      await removeStaleActivePort(activePortFile);

      const args = [
        ...isolationArgs,
        ...(headless ? ["--headless=new"] : []),
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-component-update",
        "--disable-renderer-backgrounding",
        "--disable-sync",
        "--metrics-recording-only",
        ...(windowSizeArg ? [windowSizeArg] : []),
        "about:blank",
      ];
      if (noSandbox) args.unshift("--no-sandbox", "--disable-setuid-sandbox");

      const chromiumEnvironment = { ...(options.env || {}) };
      if (!headless) chromiumEnvironment.DISPLAY = display;
      spawnAttempt = { previousRecord: context.processes?.get(label) ?? null };
      child = context.spawnOwned(label, executablePath, args, {
        env: context.isolatedEnvironment(chromiumEnvironment, options.passEnv || []),
      });
      const ownedProcessRecord = context.processes?.get(label) ?? null;
      startedAt = performance.now();
      startup = { executablePath, phase: "endpoint", endpointReadyMs: null, connectedMs: null };
      let spawnError = null;
      onSpawnError = error => { spawnError = error; };
      if (typeof child.once === "function") child.once("error", onSpawnError);

      let playwrightBrowser = null;
      let persistentContext = null;
      let closed = false;
      const pageErrors = [];
      let pageErrorsWritePromise = null;
      close = closeOwnedBrowser(
        context,
        owner,
        child,
        ownedProcessRecord,
        () => playwrightBrowser,
        () => releaseProfileOwner(context, owner),
        closeTimeoutMs,
      );
      closeAndMark = async () => {
        closed = true;
        const failures = [];
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
        if (pageErrors.length) {
          pageErrorsWritePromise ??= context.writeArtifactJsonInternal(`${label}-page-errors.json`, pageErrors);
          try {
            await pageErrorsWritePromise;
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, `Chromium ${label} close and evidence persistence failed`);
      };
      context.addCleanup(`close ${label} CDP client`, closeAndMark);

      const activePort = await poll(async () => {
        const observedSpawnError = spawnError || context.processes?.get(label)?.spawnError;
        if (observedSpawnError) {
          const message = typeof observedSpawnError === "string" ? observedSpawnError : observedSpawnError.message;
          throw new Error(`Chromium failed to spawn: ${message || "unknown spawn error"}`, { cause: observedSpawnError });
        }
        if (child.exitCode != null || child.signalCode != null) {
          throw new Error(`Chromium exited before CDP became ready (code ${child.exitCode}, signal ${child.signalCode})`);
        }
        return readActivePort(activePortFile);
      }, startTimeoutMs, `${label} CDP endpoint`, 50, context.abortSignal);
      startup.endpointReadyMs = Math.round(performance.now() - startedAt);
      context.registerPort(portLabel, activePort.port);

      startup.phase = "connect";
      const remainingStartMs = startTimeoutMs - (performance.now() - startedAt);
      if (remainingStartMs <= 0) throw deadlineError(`${label} CDP connection`, startTimeoutMs);
      const effectiveConnectTimeoutMs = Math.max(1, Math.min(connectTimeoutMs, remainingStartMs));
      try {
        playwrightBrowser = await boundedOperation(
          () => chromiumDriver.connectOverCDP(
            `ws://127.0.0.1:${activePort.port}${activePort.webSocketPath}`,
            { timeout: effectiveConnectTimeoutMs },
          ),
          effectiveConnectTimeoutMs,
          `${label} CDP connection`,
          {
            signal: context.abortSignal,
            onLateResolve: browser => {
              void closeLateResource(context, label, browser, "browser", closeTimeoutMs, closeAndMark);
            },
          },
        );
      } catch (error) {
        throw new Error(`Chromium ${label} CDP endpoint never became ready: ${error.message}`, { cause: error });
      }
      startup.connectedMs = Math.round(performance.now() - startedAt);
      startup.phase = "ready";
      startup.version = typeof playwrightBrowser.version === "function" ? playwrightBrowser.version() : null;

      const contexts = typeof playwrightBrowser.contexts === "function" ? playwrightBrowser.contexts() : null;
      if (contexts === null) {
        // Older injected lifecycle mocks omit Browser.contexts; keep their
        // ordinary newPage path while refusing persistent-page creation below.
        persistentContext = null;
      } else {
        if (!Array.isArray(contexts) || contexts.length !== 1 || typeof contexts[0]?.newPage !== "function") {
          throw new Error(`Chromium ${label} must connect with exactly one default context`);
        }
        persistentContext = contexts[0];
      }

      const observe = page => observePage(context, label, () => closed, pageErrors, page);
      const createPage = async (operation, phase) => {
        try {
          const page = await boundedOperation(operation, pageTimeoutMs, `${label} ${phase}`, {
            signal: context.abortSignal,
            onLateResolve: latePage => {
              void closeLateResource(context, label, latePage, phase, closeTimeoutMs, closeAndMark);
            },
          });
          return observe(page);
        } catch (error) {
          if (error?.code === "ETIMEDOUT" || context.abortSignal?.aborted) {
            try {
              await closeAndMark();
            } catch (cleanupError) {
              throw new AggregateError([error, cleanupError], `Chromium ${label} ${phase} and owned cleanup failed`);
            }
          }
          throw error;
        }
      };
      await writeStartupEvidence(context, label, child, startup, startedAt);
      startupEvidenceWritten = true;
      if (typeof child.removeListener === "function") child.removeListener("error", onSpawnError);
      return {
        browser: playwrightBrowser,
        child,
        cdpPort: activePort.port,
        executablePath,
        headless,
        display: headless ? null : display,
        noSandbox,
        sandboxedIframeIsolation: options.sandboxedIframeIsolation || "browser-default",
        profileDir,
        newPage: pageOptions => createPage(() => playwrightBrowser.newPage(pageOptions), "newPage"),
        newPersistentPage: () => {
          if (!persistentContext) throw new Error(`Chromium ${label} has no captured default context for persistent pages`);
          return createPage(() => persistentContext.newPage(), "newPersistentPage");
        },
        close: async () => {
          await closeAndMark();
        },
      };
    } catch (error) {
      const primaryError = error;
      const failures = [primaryError];
      if (typeof child?.removeListener === "function" && typeof onSpawnError === "function") {
        child.removeListener("error", onSpawnError);
      }
      if (startup && !startupEvidenceWritten) {
        try {
          await writeStartupEvidence(context, label, child, startup, startedAt, primaryError);
        } catch (evidenceError) {
          failures.push(evidenceError);
        }
      }
      if (close) {
        try {
          await closeAndMark();
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      } else if (spawnAttempt) {
        const record = context.processes?.get(label) ?? null;
        if (record && record !== spawnAttempt.previousRecord) {
          try {
            await context.stopOwned(label);
            if (context.processes?.get(label) !== record || !record.stopped) {
              throw new Error(`owned Chromium process ${label} has not been confirmed stopped after spawn failure`);
            }
            if (record.stopPromise) await record.stopPromise;
            if (record.child?.exitCode === null && record.child?.signalCode == null) {
              throw new Error(`owned Chromium process ${label} has not exited after spawn failure`);
            }
            releaseProfileOwner(context, owner);
          } catch (cleanupError) {
            failures.push(cleanupError);
          }
        } else {
          releaseProfileOwner(context, owner);
        }
      } else {
        releaseProfileOwner(context, owner);
      }
      if (failures.length === 1) throw primaryError;
      throw new AggregateError(
        failures,
        `${label} startup failed during ${startup?.phase ?? "setup"}: ${primaryError.message}; evidence or cleanup also failed`,
        { cause: primaryError },
      );
    }
  };
}

async function writeStartupEvidence(context, label, child, startup, startedAt, error) {
  const readOptional = path => readFile(path, "utf8").catch(() => null);
  const linux = process.platform === "linux";
  const [resolvedExecutable, processStatus, waitChannel, ioPressure] = await Promise.all([
    realpath(startup.executablePath).catch(() => null),
    linux && child?.pid ? readOptional(`/proc/${child.pid}/status`) : null,
    linux && child?.pid ? readOptional(`/proc/${child.pid}/wchan`) : null,
    linux ? readOptional("/proc/pressure/io") : null,
  ]);
  await context.writeArtifactJson(`${label}-startup.json`, {
    ...startup,
    resolvedExecutable,
    elapsedMs: Math.round(performance.now() - startedAt),
    exitCode: child?.exitCode ?? null,
    signalCode: child?.signalCode ?? null,
    processState: processStatus?.match(/^State:\s*(.+)$/m)?.[1] ?? null,
    waitChannel: waitChannel?.trim() ?? null,
    ioPressure,
    error: error ? context.redactText(error.message) : null,
  });
}

export const startChromium = createChromiumLauncher();
