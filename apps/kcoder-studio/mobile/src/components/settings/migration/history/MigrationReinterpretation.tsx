import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui";
import { SettingsGroup } from "../../settings-layout";
import { t } from "@/i18n";
import { useThemedStyles } from "@/theme";
import { migrationError, migrationRequestId, type MigrationCalls, type MobileMigrationClient } from "@/runtime/migration-client";
import { useMigrationAction } from "../workbench/useMigrationAction";
import { Confirm, MigrationProblem } from "../workbench/WorkbenchUi";
import { makeStyles } from "../migration-result-ui";

export function MigrationReinterpretation({ client, sourceJobId, onCreated }: { client: MobileMigrationClient; sourceJobId: string; onCreated(id: string): void }) {
  const styles = useThemedStyles(makeStyles), action = useMigrationAction(client);
  const [preview, setPreview] = useState<MigrationCalls["reinterpretPreview"][1] | null>(null);
  const [requestId, setRequest] = useState<string | null>(null);
  const [word, setWord] = useState("");
  async function create() {
    if (!preview || !preview.canCreate || word !== "REINTERPRET") return;
    const id = requestId ?? migrationRequestId(); setRequest(id);
    await action.run(async () => {
      if (requestId) {
        try { return await client.call("historyRead", { jobId: requestId }); }
        catch (error) { if (migrationError(error) !== "history_job_not_found") throw error; }
      }
      const fresh = await client.call("reinterpretPreview", { sourceJobId });
      if (!fresh.canCreate || fresh.sourceSequence !== preview.sourceSequence || fresh.sourceRevision !== preview.sourceRevision || fresh.parserRevision !== preview.parserRevision) throw new Error("history_reinterpretation_preview_changed");
      return client.call("reinterpretCreate", { requestId: id, sourceJobId, expectedSourceSequence: fresh.sourceSequence });
    }, value => onCreated(value.job.jobId));
  }
  return <SettingsGroup title={t("migration_history.reinterpret")} testID="migration-history-reinterpretation">
    <Text style={styles.note}>{t("migration_history.reinterpret_note")}</Text>
    <MigrationProblem code={action.error}/>
    <Button testID="migration-reinterpret-preview" variant="ghost" disabled={action.busy} onPress={() => { void action.run(() => client.call("reinterpretPreview", { sourceJobId }), value => { setPreview(value); setWord(""); }); }}>{t("migration_history.check_parser")}</Button>
    {preview ? <View style={styles.stack}>
      <Text selectable style={styles.note}>{preview.sourceRevision} → {preview.parserRevision}</Text>
      {preview.reasonCode ? <Text style={styles.warning}>{preview.reasonCode}</Text> : null}
      {preview.canCreate ? <Confirm testID="migration-reinterpret-confirm" keyword="REINTERPRET" value={word} onChange={setWord} onConfirm={() => { void create(); }} onDismiss={() => { setPreview(null); setWord(""); }} busy={action.busy}/> : null}
    </View> : null}
    {requestId ? <Text selectable style={styles.note}>{t("migration_history.original_operation", { id: requestId })}</Text> : null}
    {requestId ? <Button testID="migration-reinterpret-reconcile" variant="ghost" disabled={action.busy} onPress={() => { void action.run(() => client.call("historyRead", { jobId: requestId }), value => onCreated(value.job.jobId)); }}>{t("migration_workbench.reconcile")}</Button> : null}
  </SettingsGroup>;
}
