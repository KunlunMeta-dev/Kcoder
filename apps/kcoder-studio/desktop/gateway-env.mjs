import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";

const DESKTOP_AUTH_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,512}$/;
const MAX_DESKTOP_AUTH_TOKEN_FILE_BYTES = 512;

export function validateDesktopAuthToken(token) {
  if (typeof token !== "string" || !DESKTOP_AUTH_TOKEN_PATTERN.test(token)) {
    throw new Error("Desktop Gateway auth token must be a 32 to 512 character URL-safe value");
  }
  return token;
}

function validatePrivateTokenFileInfo(info, currentUid) {
  if (!info.isFile()) {
    throw new Error("Desktop Gateway auth token file must be a regular file");
  }
  if (info.uid !== currentUid) {
    throw new Error("Desktop Gateway auth token file must be owned by the current user");
  }
  const mode = info.mode & 0o777;
  if ((mode & ~0o600) !== 0 || (mode & 0o400) === 0) {
    throw new Error("Desktop Gateway auth token file must be owner-readable with no group or other permissions");
  }
  if (info.size > MAX_DESKTOP_AUTH_TOKEN_FILE_BYTES) {
    throw new Error("Desktop Gateway auth token file exceeds the 512 byte limit");
  }
}

async function readDesktopAuthTokenFile(filePath) {
  if (typeof filePath !== "string" || !filePath || !isAbsolute(filePath)) {
    throw new Error("Desktop Gateway auth token file path must be absolute");
  }
  if (typeof process.getuid !== "function") {
    throw new Error("Desktop Gateway auth token file owner cannot be verified on this platform");
  }

  const currentUid = process.getuid();
  let pathInfo;
  try {
    pathInfo = await lstat(filePath);
  } catch {
    throw new Error("Desktop Gateway auth token file is unavailable");
  }
  if (pathInfo.isSymbolicLink()) {
    throw new Error("Desktop Gateway auth token file cannot be a symbolic link");
  }
  validatePrivateTokenFileInfo(pathInfo, currentUid);

  let tokenFile;
  try {
    const flags = fsConstants.O_RDONLY |
      (fsConstants.O_NOFOLLOW ?? 0) |
      (fsConstants.O_NONBLOCK ?? 0);
    tokenFile = await open(filePath, flags);
  } catch {
    throw new Error("Desktop Gateway auth token file could not be opened safely");
  }

  try {
    validatePrivateTokenFileInfo(await tokenFile.stat(), currentUid);
    const buffer = Buffer.alloc(MAX_DESKTOP_AUTH_TOKEN_FILE_BYTES + 1);
    const { bytesRead } = await tokenFile.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_DESKTOP_AUTH_TOKEN_FILE_BYTES) {
      throw new Error("Desktop Gateway auth token file exceeds the 512 byte limit");
    }
    return validateDesktopAuthToken(buffer.subarray(0, bytesRead).toString("utf8").trim());
  } finally {
    await tokenFile.close();
  }
}

export function createGatewayChildEnv(sourceEnv = {}) {
  const env = { ...sourceEnv };
  delete env.KCODER_STUDIO_DESKTOP_AUTH_TOKEN;
  delete env.KCODER_STUDIO_DESKTOP_AUTH_TOKEN_FILE;
  delete env.KCODER_STUDIO_DESKTOP_PUBLIC_ORIGINS;
  delete env.KCODER_STUDIO_DESKTOP_PUBLIC_ACCESS_URL;
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("KCODER_RELAY_") ||
        key.toUpperCase().startsWith("KCODER_STUDIO_DESKTOP_RELAY_")) delete env[key];
  }
  return env;
}

export async function createDesktopGatewayConfig(sourceEnv = process.env) {
  const token = sourceEnv.KCODER_STUDIO_DESKTOP_AUTH_TOKEN_FILE !== undefined
    ? await readDesktopAuthTokenFile(sourceEnv.KCODER_STUDIO_DESKTOP_AUTH_TOKEN_FILE)
    // One Desktop owner keeps its authentication identity across child restarts.
    : randomBytes(32).toString("base64url");

  const env = { ...sourceEnv };
  if (sourceEnv.KCODER_STUDIO_DESKTOP_PUBLIC_ORIGINS !== undefined) {
    env.KCODER_STUDIO_PUBLIC_ORIGINS = sourceEnv.KCODER_STUDIO_DESKTOP_PUBLIC_ORIGINS;
  }
  if (sourceEnv.KCODER_STUDIO_DESKTOP_PUBLIC_ACCESS_URL !== undefined) {
    env.KCODER_STUDIO_PUBLIC_ACCESS_URL = sourceEnv.KCODER_STUDIO_DESKTOP_PUBLIC_ACCESS_URL;
  }

  return {
    env: createGatewayChildEnv(env),
    token,
  };
}
