import AsyncStorage from "@react-native-async-storage/async-storage";
import type { MetadataLease } from "./idb-metadata-gate.mjs";
import * as secure from "./secure";

export type MetadataAuthority = MetadataLease;
/** Invoke synchronous storage dispatch inside the owning UA request task. No network work. */
export async function metadataDispatch<T>(authority: MetadataAuthority | undefined, operation: () => Promise<T>, check?: () => void): Promise<T> {
  const dispatch = () => { check?.(); return { response: operation() }; };
  if (!authority) return dispatch().response;
  const started = await authority.effect(dispatch);
  return started.response;
}
export function metadataStorage(authority?: MetadataAuthority, check?: () => void) {
  return {
    getItem: (key: string) => metadataDispatch(authority, () => AsyncStorage.getItem(key), check),
    setItem: (key: string, value: string) => metadataDispatch(authority, () => AsyncStorage.setItem(key, value), check),
    removeItem: (key: string) => metadataDispatch(authority, () => AsyncStorage.removeItem(key), check),
    getAllKeys: () => metadataDispatch(authority, () => AsyncStorage.getAllKeys(), check),
    multiGet: (keys: readonly string[]) => metadataDispatch(authority, () => AsyncStorage.multiGet(keys), check),
    multiRemove: (keys: readonly string[]) => metadataDispatch(authority, () => AsyncStorage.multiRemove(keys), check),
    multiSet: (rows: readonly [string, string][]) => metadataDispatch(authority, () => AsyncStorage.multiSet(rows), check),
  };
}
export function metadataSecure(authority?: MetadataAuthority) {
  return {
    getSecureValue: (key: string) => metadataDispatch(authority, () => secure.getSecureValue(key)),
    setSecureValue: (key: string, value: string) => metadataDispatch(authority, () => secure.setSecureValue(key, value)),
    deleteSecureValue: (key: string) => metadataDispatch(authority, () => secure.deleteSecureValue(key)),
  };
}

/** Abort only the dependent transaction created by this callback, never another owner's DB. */
export function bindMetadataTransaction(authority: MetadataAuthority | undefined, transaction: IDBTransaction): () => void {
  if (!authority) return () => {};
  authority.assert();
  return authority.onRevoke(() => { try { transaction.abort(); } catch { /* A committed child transaction cannot be rolled back. */ } });
}
