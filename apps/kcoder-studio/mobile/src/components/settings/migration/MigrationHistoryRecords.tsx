import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Button } from "@/components/ui";
import { SettingsGroup, SettingsRow } from "../settings-layout";
import { Empty, PageControls, ReadNotice, makeStyles, appendPage } from "./migration-result-ui";
import { useMigrationRead } from "./useMigrationRead";
import { type MigrationResultsReader } from "@/runtime/migration-results";
import { t } from "@/i18n";
import { useThemedStyles } from "@/theme";
export function MigrationHistoryRecords({ reader, jobId }: {
    reader: MigrationResultsReader;
    jobId: string;
}) {
    const styles = useThemedStyles(makeStyles);
    const [pages, setPages] = useState<number[]>([0]);
    const [record, setRecord] = useState<number | null>(null);
    const page = useMigrationRead(reader, "transcript", { jobId, cursor: pages.at(-1) ?? 0 }, record === null);
    return <SettingsGroup title={t("migration_results.records")}>
    {record === null ? <>
      <Text style={styles.note}>{t("migration_results.archive_order")}</Text>
      <ReadNotice loading={page.loading} error={page.error}/>
      {page.value?.title ? <Text style={styles.title}>{page.value.title}</Text> : null}
      {page.value?.items.map(row => <SettingsRow key={row.record} testID={`migration-record-${row.record}`} label={t("migration_results.record", { number: row.record + 1 })} note={t(row.role ? `migration_results.role_${row.role}` : `migration_results.record_${row.kind}`) + (row.totalDiagnostics ? ` · ${t("migration_results.issue_count", { count: row.totalDiagnostics })}` : "")} onPress={() => setRecord(row.record)}/>)}
      {page.value?.items.length === 0 ? <Empty /> : null}
      <PageControls onFirst={() => setPages([0])} previous={pages.length > 1} next={page.value?.nextCursor != null} onPrevious={() => setPages(v => v.slice(0, -1))} onNext={() => { const cursor = page.value?.nextCursor; if (cursor != null)
            setPages(v => appendPage(v, cursor)); }}/>
    </> : <>
      <Button variant="ghost" onPress={() => setRecord(null)}>{t("migration_results.back_to_records")}</Button>
      <RecordBlocks key={record} reader={reader} jobId={jobId} record={record}/>
    </>}
  </SettingsGroup>;
}
export function RecordBlocks({ reader, jobId, record }: {
    reader: MigrationResultsReader;
    jobId: string;
    record: number;
}) {
    const styles = useThemedStyles(makeStyles);
    const [pages, setPages] = useState<number[]>([0]);
    const [block, setBlock] = useState<number | null>(null);
    const page = useMigrationRead(reader, "blocks", { jobId, record, cursor: pages.at(-1) ?? 0 }, block === null);
    return block !== null ? <>
    <Button variant="ghost" onPress={() => setBlock(null)}>{t("migration_results.back_to_blocks")}</Button>
    <BlockText key={block} reader={reader} jobId={jobId} record={record} blockIndex={block}/>
  </> : <View style={styles.stack}>
    <ReadNotice loading={page.loading} error={page.error}/>
    {page.value?.blocks.map(value => <View key={value.index} style={styles.row}>
      <Text style={styles.title}>{t(`migration_results.block_${value.kind}`)}</Text>
      {value.preview ? <Text selectable numberOfLines={4} style={styles.text}>{value.preview}</Text> : null}
      {value.outcome ? <Text style={styles.note}>{t(`migration_results.outcome_${value.outcome}`)}</Text> : null}
      {value.bodyAvailable ? <Button variant="ghost" onPress={() => setBlock(value.index)}>{t("migration_results.read_text")}</Button> : <Text style={styles.note}>{t("migration_results.opaque_note")}</Text>}
    </View>)}
    <PageControls onFirst={() => setPages([0])} previous={pages.length > 1} next={page.value?.nextCursor != null} onPrevious={() => setPages(v => v.slice(0, -1))} onNext={() => { const cursor = page.value?.nextCursor; if (cursor != null)
        setPages(v => appendPage(v, cursor)); }}/>
  </View>;
}
function BlockText({ reader, jobId, record, blockIndex }: {
    reader: MigrationResultsReader;
    jobId: string;
    record: number;
    blockIndex: number;
}) {
    const styles = useThemedStyles(makeStyles);
    const [pages, setPages] = useState<Array<string | null>>([null]);
    const page = useMigrationRead(reader, "text", { jobId, record, blockIndex, cursor: pages.at(-1) ?? null }, true);
    return <View style={styles.stack}>
    <ReadNotice loading={page.loading} error={page.error}/>
    <ScrollView nestedScrollEnabled style={{ maxHeight: 320 }}><Text selectable style={styles.text}>{page.value?.text ?? ""}</Text></ScrollView>
    <PageControls onFirst={() => setPages([null])} previous={pages.length > 1} next={!!page.value?.nextCursor} onPrevious={() => setPages(v => v.slice(0, -1))} onNext={() => { const cursor = page.value?.nextCursor; if (cursor)
        setPages(v => appendPage(v, cursor)); }}/>
  </View>;
}
