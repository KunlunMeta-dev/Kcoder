import { Platform } from "react-native";

// Profile metadata commits and workspace send-start/write checks share one
// short critical section on Native. Other Native locks retain their contract.
let nativeProfileIndexTail: Promise<unknown> | undefined;

export function canCoordinateDeviceAuthorization(): boolean {
  return Platform.OS !== "web" || typeof document === "undefined" || typeof navigator.locks?.request === "function";
}
/** Web Locks serialize tabs on the same origin; Native owns one application JS realm. */
export async function withLocalIdentityLock<T>(key: string, operation: () => Promise<T>, requireWebLock = true): Promise<T> {
  if (Platform.OS !== "web") {
    if (key !== "gateway-profile-index") return operation();
    const current = (nativeProfileIndexTail ?? Promise.resolve()).catch(() => {}).then(operation);
    nativeProfileIndexTail = current;
    return current.finally(() => { if (nativeProfileIndexTail === current) nativeProfileIndexTail = undefined; });
  }
  if (typeof document === "undefined") return operation();
  if (typeof navigator.locks?.request === "function") return await navigator.locks.request(`kcoder-mobile:${key}`, { mode: "exclusive" }, operation);
  if (!requireWebLock) return operation();
  return Promise.reject(new Error("此浏览器无法安全协调多个页面的设备授权或创建操作。请使用 APP 或支持 Web Locks 的新版浏览器；重新配对可使用临时授权。"));
}
