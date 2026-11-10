import { createHash } from "node:crypto";
import { lstat as fsLstat } from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";

export const WORKSPACE_CWD_OBSERVATION_VERSION = 1;
export const WORKSPACE_CWD_MAX_PATH_LENGTH = 2048;
export const WORKSPACE_CWD_MAX_SEGMENTS = 128;
export const WORKSPACE_CWD_OBSERVATION_TIMEOUT_MS = 3000;

function unknown(reason) {
  return { status: "unknown", reason };
}

function filesystemErrorReason(error) {
  switch (error?.code) {
    case "EACCES":
    case "EPERM":
      return "permission_denied";
    case "ENOTDIR":
      return "not_directory";
    case "ELOOP":
      return "symlink_loop";
    case "EIO":
      return "io_error";
    default:
      return "unobservable";
  }
}

export function normalizeWorkspaceCwdPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > WORKSPACE_CWD_MAX_PATH_LENGTH ||
    value.includes("\0") ||
    !isAbsolute(value)
  ) {
    return null;
  }
  try {
    const normalizedPath = resolve(value);
    const { root } = parse(normalizedPath);
    const segmentCount = normalizedPath
      .slice(root.length)
      .split(sep)
      .filter(Boolean).length;
    return segmentCount <= WORKSPACE_CWD_MAX_SEGMENTS ? normalizedPath : null;
  } catch {
    return null;
  }
}

/**
 * Observe a local workspace without starting an app-server or changing the filesystem.
 * A single result is point-in-time evidence, not a durable deletion receipt.
 */
export async function observeWorkspaceCwd(
  transport,
  workspacePath,
  { lstat = fsLstat } = {},
) {
  if (transport !== "local") return unknown("unsupported_transport");

  const normalizedPath = normalizeWorkspaceCwdPath(workspacePath);
  if (!normalizedPath) return unknown("invalid_path");

  const { root } = parse(normalizedPath);
  const components = normalizedPath.slice(root.length).split(sep).filter(Boolean);
  let currentPath = root;

  // Walk components without realpath; concurrent filesystem changes can race this point-in-time check.
  for (let index = -1; index < components.length; index += 1) {
    const isRoot = index === -1;
    if (!isRoot) currentPath = join(currentPath, components[index]);

    let info;
    try {
      info = await lstat(currentPath);
    } catch (error) {
      if (error?.code !== "ENOENT") return unknown(filesystemErrorReason(error));
      return !isRoot && index === components.length - 1
        ? { status: "absent" }
        : unknown("parent_missing");
    }

    if (info.isSymbolicLink())
      return unknown(isRoot || index < components.length - 1 ? "parent_symlink" : "symlink");
    if (!info.isDirectory()) return unknown("not_directory");
  }

  return { status: "present" };
}

export function createWorkspaceCwdObserver({ delayMs = 0 } = {}) {
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 10_000)
    throw new RangeError("delayMs must be an integer from 0 to 10000");
  let delayed = false;
  return async (transport, workspacePath) => {
    if (delayMs > 0 && !delayed) {
      delayed = true;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
    return observeWorkspaceCwd(transport, workspacePath);
  };
}

/** Opaque inventory precondition; the underlying stored target descriptor stays private. */
export function workspaceCwdObservationTargetIdentity(signature) {
  return createHash("sha256").update(signature).digest("hex");
}

/** Create once per Gateway process and share across request-scoped services. */
export function createWorkspaceCwdObservationCoordinator({
  timeoutMs = WORKSPACE_CWD_OBSERVATION_TIMEOUT_MS,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new RangeError("timeoutMs must be an integer from 1 to 60000");

  const pendingObservations = new Map();
  return Object.freeze({
    run(targetId, transport, workspacePath, observe = observeWorkspaceCwd) {
      if (typeof observe !== "function")
        return Promise.resolve(unknown("unobservable"));
      if (pendingObservations.has(targetId))
        return Promise.resolve(unknown("observation_in_progress"));

      const pending = Promise.resolve()
        .then(() => observe(transport, workspacePath))
        .catch(() => unknown("unobservable"));
      pendingObservations.set(targetId, pending);
      void pending.then(() => {
        if (pendingObservations.get(targetId) === pending)
          pendingObservations.delete(targetId);
      });

      let timer;
      const timedOut = new Promise((resolveObservation) => {
        timer = setTimeout(
          () => resolveObservation(unknown("timeout")),
          timeoutMs,
        );
      });
      const completed = pending.then((result) => {
        clearTimeout(timer);
        return result;
      });
      return Promise.race([completed, timedOut]).finally(() => {
        clearTimeout(timer);
      });
    },
  });
}

/**
 * Build a request-scoped observer that rejects results if target, login owner,
 * authorization, or account generation changes while the filesystem check runs.
 */
export function createWorkspaceCwdObservationService({
  getTarget,
  getSession,
  getLoginOwner,
  getLoginGeneration,
  getTargetSignature,
  observe = observeWorkspaceCwd,
  coordinator = createWorkspaceCwdObservationCoordinator(),
  now = Date.now,
}) {
  for (const [name, value] of Object.entries({
    getTarget,
    getSession,
    getLoginOwner,
    getLoginGeneration,
    getTargetSignature,
  })) {
    if (typeof value !== "function")
      throw new TypeError(`${name} must be a function`);
  }
  if (typeof observe !== "function") throw new TypeError("observe must be a function");
  if (!coordinator || typeof coordinator.run !== "function")
    throw new TypeError("coordinator must be a workspace cwd observation coordinator");

  const capture = async (targetId) => {
    const session = await getSession();
    const target = getTarget(targetId);
    if (
      !session ||
      !target ||
      !session.allowedServerIds?.has(targetId)
    ) {
      return { authorized: false };
    }
    const loginOwner = getLoginOwner(session, targetId);
    if (typeof loginOwner !== "string" || loginOwner.length === 0)
      return { authorized: false };
    const generation = getLoginGeneration(loginOwner, targetId);
    const signature = getTargetSignature(target);
    if (!Number.isSafeInteger(generation) || typeof signature !== "string")
      return { authorized: false };
    return { authorized: true, target, loginOwner, generation, signature };
  };

  return async ({ targetId, workspacePath, expectedTargetIdentity }) => {
    const before = await capture(targetId);
    if (!before.authorized) return { authorized: false };

    const normalizedPath = normalizeWorkspaceCwdPath(workspacePath);
    let observation;
    if (typeof expectedTargetIdentity !== "string" || !/^[a-f0-9]{64}$/.test(expectedTargetIdentity)) {
      observation = unknown("unbound_target");
    } else if (expectedTargetIdentity !== workspaceCwdObservationTargetIdentity(before.signature)) {
      observation = unknown("target_changed");
    } else if (!normalizedPath) {
      observation = unknown("invalid_path");
    } else if (before.target.transport !== "local") {
      observation = unknown("unsupported_transport");
    } else {
      observation = await coordinator.run(
        targetId,
        before.target.transport,
        normalizedPath,
        observe,
      );
    }

    const after = await capture(targetId);
    if (!after.authorized) return { authorized: false };

    const scopeStable =
      before.signature === after.signature &&
      before.loginOwner === after.loginOwner &&
      before.generation === after.generation;
    const result = scopeStable ? observation : unknown("scope_changed");
    return {
      authorized: true,
      version: WORKSPACE_CWD_OBSERVATION_VERSION,
      targetId,
      targetSignature: workspaceCwdObservationTargetIdentity(after.signature),
      loginGeneration: after.generation,
      ...(normalizedPath ? { workspacePath: normalizedPath } : {}),
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
      observedAt: now(),
    };
  };
}

export function createWorkspaceCwdObservationHttpHandler({
  gateway,
  observe = observeWorkspaceCwd,
  coordinator = createWorkspaceCwdObservationCoordinator(),
}) {
  const {
    getTarget,
    authenticatedSession,
    requestLoginOwner,
    loginContexts,
    serverHealthSignature,
    jsonResponse,
  } = gateway ?? {};
  for (const [name, value] of Object.entries({
    getTarget,
    authenticatedSession,
    requestLoginOwner,
    loginContexts,
    serverHealthSignature,
    jsonResponse,
  })) {
    if (!value) throw new TypeError(`${name} is required for workspace cwd observation`);
  }
  if (typeof getTarget !== "function" ||
      typeof authenticatedSession !== "function" ||
      typeof requestLoginOwner !== "function" ||
      typeof serverHealthSignature !== "function" ||
      typeof jsonResponse !== "function" ||
      typeof observe !== "function" ||
      typeof coordinator.run !== "function" ||
      typeof loginContexts.generation !== "function") {
    throw new TypeError("invalid workspace cwd observation Gateway dependencies");
  }

  return async ({ pathname, request, response, requestUrl, authSession }) => {
    const route = String(pathname || "").match(
      /^\/api\/servers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/cwd-observation$/,
    );
    if (!route) return false;
    const targetId = route[1];
    if (request.method !== "GET") {
      jsonResponse(response, 405, { error: "Method not allowed" });
      return true;
    }
    const target = getTarget(targetId);
    if (!target || !authSession?.allowedServerIds?.has(targetId)) {
      jsonResponse(response, 404, { error: "Runtime target is unavailable" });
      return true;
    }
    if (!requestLoginOwner(request, authSession)) {
      jsonResponse(response, 401, { error: "Authentication required" });
      return true;
    }

    const observationService = createWorkspaceCwdObservationService({
      getTarget,
      getSession: () => authenticatedSession(request),
      getLoginOwner: (session) => requestLoginOwner(request, session),
      getLoginGeneration: loginContexts.generation,
      getTargetSignature: serverHealthSignature,
      coordinator,
      observe,
    });
    const requestedWorkspaces = requestUrl.searchParams.getAll("workspace");
    const expectedIdentities = requestUrl.searchParams.getAll("expectedTargetIdentity");
    const observation = await observationService({
      targetId,
      workspacePath: requestedWorkspaces.length === 1 ? requestedWorkspaces[0] : null,
      expectedTargetIdentity: expectedIdentities.length === 1 ? expectedIdentities[0] : null,
    });
    if (!observation.authorized) {
      const currentSession = await authenticatedSession(request);
      jsonResponse(
        response,
        currentSession ? 404 : 401,
        { error: currentSession ? "Runtime target is unavailable" : "Authentication required" },
      );
      return true;
    }
    jsonResponse(response, 200, observation);
    return true;
  };
}
