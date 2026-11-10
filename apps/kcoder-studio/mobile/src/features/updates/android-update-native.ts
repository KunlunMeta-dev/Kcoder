import { requireOptionalNativeModule } from "expo";
import type { AndroidUpdater, AndroidUpdate, DownloadProgress, InstalledAndroidApp } from "./android-updates";

interface NativeUpdater {
  getInstalledInfo(): Promise<InstalledAndroidApp>;
  canInstall(): Promise<boolean>;
  openInstallPermission(): Promise<void>;
  prepareDownload(requestId: string): void;
  downloadUpdate(url: string, digest: string, size: number, code: number, version: string, requestId: string): Promise<void>;
  cancelDownload(requestId: string): void;
  installUpdate(requestId: string): Promise<void>;
  addListener(event: string, callback: (progress: DownloadProgress) => void): { remove(): void };
}
const native = requireOptionalNativeModule<NativeUpdater>("KCoderAppUpdates");
export const androidUpdater: AndroidUpdater | null = native ? {
  getInstalledInfo: () => native.getInstalledInfo(),
  canInstall: () => native.canInstall(),
  openInstallPermission: () => native.openInstallPermission(),
  download: (update: AndroidUpdate, requestId: string) => {
    native.prepareDownload(requestId);
    return native.downloadUpdate(update.url, update.sha256, update.size, update.versionCode, update.version, requestId);
  },
  cancelDownload: requestId => native.cancelDownload(requestId),
  installUpdate: requestId => native.installUpdate(requestId),
  onProgress: listener => native.addListener("onDownloadProgress", listener),
} : null;
