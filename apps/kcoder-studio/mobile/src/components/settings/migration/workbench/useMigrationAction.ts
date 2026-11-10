import { useEffect, useRef, useState } from "react";
import { migrationError, type MobileMigrationClient } from "@/runtime/migration-client";

export function useMigrationAction(client: MobileMigrationClient) {
  const generation = useRef(0);
  const mounted = useRef(true);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, [client]);
  const invalidate = () => { generation.current++; pending.current = false; setBusy(false); setError(null); };
  async function run<T>(operation: () => Promise<T>, accepted: (value: T) => void = () => {}) {
    if (pending.current || !client.available()) return;
    const ticket = ++generation.current;
    pending.current = true; setBusy(true); setError(null);
    const valid = () => mounted.current && ticket === generation.current && client.available();
    try { const result = await operation(); if (valid()) accepted(result); }
    catch (cause) { if (valid()) setError(migrationError(cause)); }
    finally { if (valid()) { pending.current = false; setBusy(false); } }
  }
  return { run, busy, error, invalidate };
}
