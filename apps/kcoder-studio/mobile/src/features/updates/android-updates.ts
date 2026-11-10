import source from "./android-update-source.json";

export const ANDROID_UPDATE_REPOSITORY = source.repository;
const MAX_APK_BYTES = 512 * 1024 * 1024;
export interface InstalledAndroidApp {
  packageName: string;
  versionName: string;
  versionCode: number;
  abis: string[];
}
export interface AndroidUpdate {
  version: string;
  versionCode: number;
  size: number;
  sha256: string;
  url: string;
  releaseUrl: string;
  notes: string;
}
export interface DownloadProgress { requestId: string; received: number; total: number }
export interface AndroidUpdater {
  getInstalledInfo(): Promise<InstalledAndroidApp>;
  canInstall(): Promise<boolean>;
  openInstallPermission(): Promise<void>;
  download(update: AndroidUpdate, requestId: string): Promise<void>;
  cancelDownload(requestId: string): void;
  installUpdate(requestId: string): Promise<void>;
  onProgress(listener: (progress: DownloadProgress) => void): { remove(): void };
}
export type AndroidUpdateErrorCode = "network" | "rate_limit" | "source_unavailable" | "no_release" | "invalid_release" |
  "integrity" | "invalid_apk" | "storage" | "busy" | "permission" | "installer" | "unavailable";
export class AndroidUpdateError extends Error {
  constructor(readonly code: AndroidUpdateErrorCode) { super(code); }
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function repositoryPath(repository: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new AndroidUpdateError("source_unavailable");
  return `/${repository}/releases/`;
}
function releaseLink(value: unknown, repository: string, kind: "tag/" | "download/"): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.port && !url.username &&
      !url.password && url.pathname.startsWith(`${repositoryPath(repository)}${kind}`) && !url.hash;
  } catch { return false; }
}

/** Select Android assets by their own build number, never a desktop release tag. */
export function selectAndroidUpdate(releases: unknown, installed: InstalledAndroidApp, repository = ANDROID_UPDATE_REPOSITORY): AndroidUpdate | null {
  repositoryPath(repository);
  if (!Array.isArray(releases) || releases.length > 100 || !Number.isSafeInteger(installed.versionCode) || installed.versionCode < 1)
    throw new AndroidUpdateError("invalid_release");
  const candidates: AndroidUpdate[] = [];
  let hasCompatibleRelease = false;
  for (const raw of releases) {
    const release = record(raw);
    if (!release || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets) ||
      !releaseLink(release.html_url, repository, "tag/")) continue;
    for (const rawAsset of release.assets) {
      const asset = record(rawAsset);
      if (!asset || typeof asset.name !== "string" || asset.state !== "uploaded") continue;
      const match = /^kcoder-studio-mobile-(\d+\.\d+\.\d+)-android-(arm64-v8a|armeabi-v7a|x86_64|universal)-(?:build|v)(\d+)\.apk$/.exec(asset.name);
      if (!match || (match[2] !== "universal" && !installed.abis.includes(match[2]))) continue;
      const versionCode = Number(match[3]);
      if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2_147_483_647) continue;
      hasCompatibleRelease = true;
      if (versionCode <= installed.versionCode) continue;
      if (!releaseLink(asset.browser_download_url, repository, "download/") || !Number.isSafeInteger(asset.size) ||
        (asset.size as number) < 1 || (asset.size as number) > MAX_APK_BYTES ||
        typeof asset.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(asset.digest))
        throw new AndroidUpdateError("invalid_release");
      candidates.push({ version: match[1], versionCode, size: asset.size as number, sha256: asset.digest.slice(7),
        url: asset.browser_download_url as string, releaseUrl: release.html_url,
        notes: typeof release.body === "string" ? release.body.slice(0, 12_000) : "" });
    }
  }
  candidates.sort((a, b) => b.versionCode - a.versionCode || a.url.localeCompare(b.url));
  if (!hasCompatibleRelease) throw new AndroidUpdateError("no_release");
  return candidates[0] ?? null;
}

export async function checkAndroidUpdate(installed: InstalledAndroidApp, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<AndroidUpdate | null> {
  signal.throwIfAborted();
  repositoryPath(ANDROID_UPDATE_REPOSITORY);
  const response = await fetcher(`https://api.github.com/repos/${ANDROID_UPDATE_REPOSITORY}/releases?per_page=100`, {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, credentials: "omit", signal,
  });
  if (response.status === 404) throw new AndroidUpdateError("source_unavailable");
  if (response.status === 403 || response.status === 429) throw new AndroidUpdateError("rate_limit");
  if (!response.ok) throw new AndroidUpdateError("network");
  const text = await response.text();
  if (text.length > 8 * 1024 * 1024) throw new AndroidUpdateError("invalid_release");
  let releases: unknown;
  try { releases = JSON.parse(text); } catch { throw new AndroidUpdateError("invalid_release"); }
  signal.throwIfAborted();
  return selectAndroidUpdate(releases, installed);
}

export function androidUpdateErrorCode(error: unknown): AndroidUpdateErrorCode {
  if (error instanceof AndroidUpdateError) return error.code;
  const code = record(error)?.code;
  if (typeof code === "string") {
    switch (code) {
      case "ERR_UPDATE_INTEGRITY": return "integrity";
      case "ERR_UPDATE_INVALID_APK": return "invalid_apk";
      case "ERR_UPDATE_INVALID_RELEASE": return "invalid_release";
      case "ERR_UPDATE_STORAGE": return "storage";
      case "ERR_UPDATE_BUSY": return "busy";
      case "ERR_UPDATE_PERMISSION": return "permission";
      case "ERR_UPDATE_INSTALLER": return "installer";
      case "ERR_UPDATE_NOT_READY": case "ERR_UPDATE_UNAVAILABLE": return "unavailable";
    }
  }
  return "network";
}
