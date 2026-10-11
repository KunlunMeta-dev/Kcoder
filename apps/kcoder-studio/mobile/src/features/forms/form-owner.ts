import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";

/** A render-time fence for these two form routes, including A -> B -> A. */
export interface FormOwner {
  key: string;
  isCurrent(): boolean;
  onDispose(cleanup: () => void): () => void;
  dispose(): void;
}

export function useFormOwner(key: string): FormOwner {
  const current = useRef<FormOwner | null>(null);
  const mounted = useRef(true);
  if (current.current?.key !== key) {
    const cleanups = new Set<() => void>();
    const owner: FormOwner = {
      key,
      isCurrent: () => mounted.current && current.current === owner,
      onDispose(cleanup) {
        if (cleanups.size >= 32) throw new Error("表单资源清理尚未完成，请稍后重试");
        cleanups.add(cleanup);
        if (!owner.isCurrent()) { owner.dispose(); return () => {}; }
        return () => { cleanups.delete(cleanup); };
      },
      dispose() {
        for (const cleanup of cleanups) {
          try { cleanup(); cleanups.delete(cleanup); }
          catch { console.warn("form_owner_cleanup_pending"); }
        }
      },
    };
    current.current = owner;
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const owner = current.current;
  useEffect(() => () => { owner.dispose(); }, [owner]);
  return owner;
}

/** Old values stay in their captured record; they are never projected into a new owner. */
export function useFormState<T>(owner: FormOwner, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const fallback = useMemo(() => typeof initial === "function" ? (initial as () => T)() : initial, [owner]);
  const [record, setRecord] = useState(() => ({ owner, value: fallback }));
  const setValue = useCallback((update: SetStateAction<T>) => {
    if (!owner.isCurrent()) return;
    setRecord((previous) => {
      if (!owner.isCurrent()) return previous;
      const value = previous.owner === owner ? previous.value : fallback;
      return { owner, value: typeof update === "function" ? (update as (value: T) => T)(value) : update };
    });
  }, [owner, fallback]);
  return [record.owner === owner ? record.value : fallback, setValue];
}
