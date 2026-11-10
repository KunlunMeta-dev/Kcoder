import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Button } from "@/components/ui";
import { t } from "@/i18n";
import { useThemedStyles } from "@/theme";
import type { MobileMigrationClient, MigrationCalls } from "@/runtime/migration-client";
import { makeStyles, PageControls } from "../migration-result-ui";
import { useMigrationAction } from "./useMigrationAction";
import { MigrationProblem } from "./WorkbenchUi";
/** Source text stays inert and bounded; opening a mapping does not automatically load it. */
export function MigrationAssetPreview({ client, jobId, itemId }: { client: MobileMigrationClient; jobId: string; itemId: string }) {
  const styles = useThemedStyles(makeStyles);
  const action = useMigrationAction(client);
  const [page, setPage] = useState<MigrationCalls["assetPreview"][1] | null>(null);
  const [offsets, setOffsets] = useState<number[]>([0]);
  function read(offset: number, next: number[]) { void action.run(() => client.call("assetPreview", { jobId, itemId, offset }), value => { setPage(value); setOffsets(next); }); }
  return <View style={styles.stack}>
    <Button testID="migration-asset-preview" variant="ghost" disabled={action.busy} onPress={() => read(0, [0])}>{t("migration_workbench.read_asset")}</Button>
    <MigrationProblem code={action.error}/>
    {page ? <>
      <ScrollView nestedScrollEnabled style={{ maxHeight: 320 }}><Text selectable style={styles.text}>{page.text}</Text></ScrollView>
      <PageControls previous={offsets.length > 1 && !action.busy} next={page.nextOffset != null && !action.busy} onPrevious={() => { const next = offsets.slice(0, -1); read(next.at(-1) ?? 0, next); }} onNext={() => { if (page.nextOffset != null) read(page.nextOffset, [...offsets.slice(-255), page.nextOffset]); }}/>
    </> : null}
  </View>;
}
