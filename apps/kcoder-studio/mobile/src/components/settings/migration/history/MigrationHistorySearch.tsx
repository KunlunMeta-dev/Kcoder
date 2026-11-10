import { useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Button, Field } from "@/components/ui";
import { SettingsGroup } from "../../settings-layout";
import { t } from "@/i18n";
import { useThemedStyles } from "@/theme";
import type { MigrationCalls, MobileMigrationClient } from "@/runtime/migration-client";
import { PageControls, appendPage, makeStyles } from "../migration-result-ui";
import { Check, MigrationProblem } from "../workbench/WorkbenchUi";
import { useHistoricalRead } from "./useHistoricalRead";
type Hit = MigrationCalls["historySearch"][1]["items"][number];

export function MigrationHistorySearch({ client, jobId, viewId }: { client: MobileMigrationClient; jobId: string; viewId?: string }) {
  const styles = useThemedStyles(makeStyles);
  // A new account, connection owner or interpretation has a new local search lifetime.
  const owner = useMemo(() => ({ client, jobId, viewId }), [client, jobId, viewId]);
  const current = useRef(owner); current.current = owner;
  const [draft, setDraft] = useState(""), [caseSensitive, setCase] = useState(false);
  const [submitted, setSubmitted] = useState<{ owner: typeof owner; query: string; caseSensitive: boolean } | null>(null);
  const [pages, setPages] = useState<Array<string | null>>([null]), [hit, setHit] = useState<{ owner: typeof owner; search: typeof submitted; value: Hit } | null>(null), [revision, setRevision] = useState(0);
  const active = submitted?.owner === owner ? submitted : null, selected = active && hit?.owner === owner && hit.search === active ? hit.value : null;
  const latestSearch = useRef(active); latestSearch.current = active;
  const ownsSearch = () => current.current === owner && latestSearch.current === active && client.available();
  const page = useHistoricalRead(client, "historySearch", { jobId, ...(viewId ? { viewId } : {}), query: active?.query ?? "", caseSensitive: active?.caseSensitive ?? false, cursor: pages.at(-1), limit: 10 }, !!active && !selected, revision);
  const canRead = client.supports(viewId ? "branchText" : "archiveText");
  function search() { if (!draft.trim() || [...draft].length > 256) return; setPages([null]); setHit(null); setSubmitted({ owner, query: draft, caseSensitive }); setRevision(value => value + 1); }
  if (!client.supports("historySearch")) return <Text style={styles.note}>{t("migration_search.unavailable")}</Text>;
  return <SettingsGroup title={t(viewId ? "migration_search.branch_title" : "migration_search.archive_title")} testID={viewId ? "migration-branch-search" : "migration-archive-search"}>
    <Text style={styles.note}>{t("migration_search.note")}</Text>
    <Field testID="migration-search-query" label={t("migration_search.query")} value={draft} onChangeText={setDraft} autoCapitalize="none" autoCorrect={false} maxLength={512}/>
    <Check testID="migration-search-case" label={t("migration_search.case")} checked={caseSensitive} onPress={() => setCase(value => !value)}/>
    <View style={styles.actions}><Button testID="migration-search-submit" disabled={!draft.trim() || [...draft].length > 256} onPress={search}>{t("migration_search.submit")}</Button><Button testID="migration-search-clear" variant="ghost" onPress={() => { setSubmitted(null); setHit(null); setPages([null]); }}>{t("migration_search.clear")}</Button></View>
    {active ? <Text selectable style={styles.note}>{t("migration_search.applied", { query: active.query })}</Text> : null}
    {selected && active ? <View key={selected.bodyCursor} style={styles.stack}>
      <Button testID="migration-search-back" variant="ghost" onPress={() => setHit(null)}>{t("migration_search.back")}</Button>
      <SearchBody client={client} jobId={jobId} viewId={viewId} hit={selected}/>
    </View> : active ? <View style={styles.stack} testID="migration-search-results">
      <MigrationProblem code={page.error}/>
      {page.loading ? <Text style={styles.note}>{t("migration_results.loading")}</Text> : null}
      {page.result ? <><Text style={styles.note}>{t("migration_search.progress", { scanned: page.result.scannedRecords, total: page.result.totalRecords, bytes: page.result.processedBytes })}</Text><Text style={styles.note}>{t("migration_search.excluded", { excluded: page.result.excludedBlocks, unsupported: page.result.unsupportedBlocks })}</Text>{!page.result.items.length ? <Text style={styles.note}>{t(page.result.nextCursor ? "migration_search.no_hits_window" : "migration_search.no_hits")}</Text> : null}</> : null}
      {page.result?.items.map((value, index) => <View key={`${value.position}:${value.block.index}:${value.bodyCursor}`} style={styles.row} testID={`migration-search-row-${index}`}>
        <Text style={styles.title}>{t("migration_search.location", { record: value.position + 1, block: value.block.index + 1 })}</Text>
        <Text style={styles.note}>{t(`migration_results.block_${value.block.kind}`)} · {t(value.role ? `migration_results.role_${value.role}` : "migration_results.role_unknown")}</Text>
        <Text selectable style={styles.text}>{value.before}<Text style={{ fontWeight: "600" }}>{value.matched}</Text>{value.after}</Text>
        <Button testID={`migration-search-hit-${index}`} variant="ghost" disabled={!canRead || !value.block.bodyAvailable} onPress={() => { if (ownsSearch()) setHit({ owner, search: active, value }); }}>{t("migration_search.read_hit")}</Button>
      </View>)}
      {!canRead ? <Text style={styles.note}>{t("migration_search.body_unavailable")}</Text> : null}
      <View style={styles.actions}><Button testID="migration-search-refresh" variant="ghost" onPress={() => setRevision(value => value + 1)}>{t("migration_results.refresh")}</Button></View>
      <PageControls previous={!page.loading && pages.length > 1} next={!page.loading && !!page.result?.nextCursor} onFirst={() => { if (ownsSearch()) setPages([null]); }} onPrevious={() => { if (ownsSearch()) setPages(old => old.slice(0, -1)); }} onNext={() => { const next = page.result?.nextCursor; if (next && ownsSearch()) setPages(old => appendPage(old, next)); }}/>
    </View> : null}
  </SettingsGroup>;
}
function SearchBody({ client, jobId, viewId, hit }: { client: MobileMigrationClient; jobId: string; viewId?: string; hit: Hit }) {
  const styles = useThemedStyles(makeStyles), [pages, setPages] = useState([hit.bodyCursor]), [revision, setRevision] = useState(0);
  const common = { jobId, blockIndex: hit.block.index, cursor: pages.at(-1) };
  const page = useHistoricalRead(client, viewId ? "branchText" : "archiveText", viewId ? { ...common, viewId, position: hit.position } : { ...common, record: hit.record }, true, revision);
  return <View testID="migration-search-body" style={styles.stack}>
    <MigrationProblem code={page.error}/>
    {page.loading ? <Text style={styles.note}>{t("migration_results.loading")}</Text> : null}
    <ScrollView nestedScrollEnabled style={{ maxHeight: 320 }}><Text selectable style={styles.text}>{page.result?.text ?? ""}</Text></ScrollView>
    <Button testID="migration-search-body-refresh" variant="ghost" onPress={() => setRevision(value => value + 1)}>{t("migration_results.refresh")}</Button>
    <PageControls previous={!page.loading && pages.length > 1} next={!page.loading && !!page.result?.nextCursor} onFirst={() => setPages([hit.bodyCursor])} onPrevious={() => setPages(old => old.slice(0, -1))} onNext={() => { const next = page.result?.nextCursor; if (next) setPages(old => appendPage(old, next)); }}/>
  </View>;
}
