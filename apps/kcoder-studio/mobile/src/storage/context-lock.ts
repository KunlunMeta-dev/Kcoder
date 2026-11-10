import { Platform } from "react-native";
import { createIndexedMetadataGate } from "./idb-metadata-gate.mjs";
import type { MetadataAuthority } from "./metadata-authority";
export type { MetadataAuthority } from "./metadata-authority";

// Profile metadata commits and workspace send-start/write checks share one
// short critical section on Native. Other Native locks retain their contract.
let nativeProfileIndexTail: Promise<unknown> | undefined;

export function canCoordinateDeviceAuthorization(): boolean {
  return Platform.OS !== "web" || typeof document === "undefined" || (typeof navigator.locks?.request === "function" || (typeof indexedDB !== "undefined" && typeof indexedDB.open === "function"));
}
/** Legacy unlinked creation has not adopted the V2 profile/receipt fence. */
export function canCoordinateLegacyCreation(): boolean {
  return Platform.OS !== "web" || typeof document === "undefined" || (typeof navigator !== "undefined" && typeof navigator.locks?.request === "function");
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

let browserGate: ReturnType<typeof createIndexedMetadataGate> | undefined;
/** The callback contains local metadata only. Use its explicit authority for every storage effect. */
export async function withLocalMetadata<T>(key: string, operation: (authority?: MetadataAuthority) => Promise<T>, parent?: MetadataAuthority): Promise<T> {
  if (Platform.OS !== "web" || typeof document === "undefined") return withLocalIdentityLock(key, () => operation(), false);
  if (typeof indexedDB !== "undefined" && typeof indexedDB.open === "function") {
    browserGate ??= createIndexedMetadataGate({ indexedDB, webLocks: navigator.locks });
    return browserGate.run(key, operation, { parent });
  }
  // Older secure contexts can retain the original UA Web Lock boundary.
  if (typeof navigator.locks?.request === "function") return navigator.locks.request(`kcoder-mobile:${key}`, { mode: "exclusive" }, async () => {
    let active = true; const dependents = new Set<() => void>();
    const authority: MetadataAuthority = { key, assert() { if (!active) throw new Error("mobile_metadata_authority_revoked"); }, onRevoke(callback) { authority.assert(); dependents.add(callback); return () => { dependents.delete(callback); }; }, async effect(effect) { authority.assert(); return effect(); } };
    try { return await operation(authority); } finally { active = false; for (const callback of dependents) callback(); dependents.clear(); }
  });
  throw new Error("mobile_metadata_coordination_unavailable");
}
