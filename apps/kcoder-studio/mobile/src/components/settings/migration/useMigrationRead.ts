import { useEffect, useState } from "react";
import { MigrationReadError, type MigrationReadName, type MigrationReadParams, type MigrationReadResults, MigrationResultsReader } from "@/runtime/migration-results";
export function useMigrationRead<N extends MigrationReadName>(reader: MigrationResultsReader, name: N, params: MigrationReadParams[N], enabled: boolean, revision = 0) {
    const key = JSON.stringify([name, params, revision]);
    const [state, setState] = useState<{
        reader: MigrationResultsReader;
        key: string;
        value: MigrationReadResults[N] | null;
        loading: boolean;
        error: string | null;
    } | null>(null);
    useEffect(() => {
        if (!enabled)
            return;
        const controller = new AbortController();
        setState({ reader, key, value: null, loading: true, error: null });
        void reader.read(name, params, controller.signal).then(value => {
            if (!controller.signal.aborted)
                setState({ reader, key, value, loading: false, error: null });
        }, error => {
            if (!controller.signal.aborted)
                setState({ reader, key, value: null, loading: false, error: error instanceof MigrationReadError ? error.reason : "failed" });
        });
        return () => controller.abort();
    }, [reader, key, enabled]);
    const current = state?.reader === reader && state.key === key ? state : null;
    return { value: enabled ? current?.value ?? null : null, loading: enabled && (current?.loading ?? true), error: enabled ? current?.error ?? null : null };
}
