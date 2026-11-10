import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Button } from "@/components/ui";
import { SettingsRow } from "../../settings-layout";
import { t } from "@/i18n";
import { useThemedStyles } from "@/theme";
import type { MobileMigrationClient } from "@/runtime/migration-client";
import { PageControls, appendPage, makeStyles } from "../migration-result-ui";
import { MigrationProblem } from "../workbench/WorkbenchUi";
import { useHistoricalRead } from "./useHistoricalRead";
import { MigrationAttachmentWorkspace } from "./MigrationAttachmentWorkspace";
import type { HistoricalLocalAttachmentBinding } from "../../../../../../shared/generated/contracts";
type BindingProps = { bindings: HistoricalLocalAttachmentBinding[]; onBinding(binding: HistoricalLocalAttachmentBinding, selected: boolean): void };

export function MigrationBranchRecords({ client, jobId, viewId, bindings, onBinding }: { client: MobileMigrationClient; jobId: string; viewId: string } & BindingProps) {
  const styles = useThemedStyles(makeStyles);
  const [pages, setPages] = useState([0]), [position, setPosition] = useState<number | null>(null);
  const read = useHistoricalRead(client, "branchPage", { jobId, viewId, cursor: pages.at(-1) }, position === null);
  if (position !== null) return <View style={styles.stack}><Button variant="ghost" onPress={() => setPosition(null)}>{t("migration_results.back_to_records")}</Button><BranchBlocks key={position} client={client} jobId={jobId} viewId={viewId} position={position} bindings={bindings} onBinding={onBinding}/></View>;
  return <View testID="migration-branch-records" style={styles.stack}>
    <MigrationProblem code={read.error}/>
    {read.result?.title ? <Text style={styles.title}>{read.result.title}</Text> : null}
    {read.result?.items.map(row => <SettingsRow key={row.position} testID={`migration-branch-record-${row.position}`} label={t("migration_results.record", { number: row.position + 1 })} note={`${t(row.record.role ? `migration_results.role_${row.record.role}` : `migration_results.record_${row.record.kind}`)} · ${row.sourceSessionId}`} onPress={() => setPosition(row.position)}/>)}
    <PageControls previous={pages.length > 1} next={read.result?.nextCursor != null} onFirst={() => setPages([0])} onPrevious={() => setPages(old => old.slice(0, -1))} onNext={() => { const next = read.result?.nextCursor; if (next != null) setPages(old => appendPage(old, next)); }}/>
  </View>;
}
function BranchBlocks({ client, jobId, viewId, position, bindings, onBinding }: { client: MobileMigrationClient; jobId: string; viewId: string; position: number } & BindingProps) {
  const styles = useThemedStyles(makeStyles);
  const [pages, setPages] = useState([0]), [selection, setSelection] = useState<{ blockIndex: number; kind: "text" | "attachment" | "tool_result" } | null>(null);
  const read = useHistoricalRead(client, "branchBlocks", { jobId, viewId, position, cursor: pages.at(-1) }, selection === null);
  if (selection) return <View style={styles.stack}><Button variant="ghost" onPress={() => setSelection(null)}>{t("migration_results.back_to_blocks")}</Button>{selection.kind === "text" ? <BranchText client={client} jobId={jobId} viewId={viewId} position={position} blockIndex={selection.blockIndex}/> : <MigrationAttachmentWorkspace client={client} selection={{ jobId, viewId, position, blockIndex: selection.blockIndex }} nested={selection.kind === "tool_result"} bindings={bindings} onBinding={onBinding}/>}</View>;
  return <View testID="migration-branch-blocks" style={styles.stack}>
    <MigrationProblem code={read.error}/>
    {read.result?.blocks.map(block => <View key={block.index} style={styles.row}>
      <Text style={styles.title}>{t(`migration_results.block_${block.kind}`)}</Text>
      {block.preview ? <Text numberOfLines={4} selectable style={styles.text}>{block.preview}</Text> : null}
      {block.outcome ? <Text style={styles.note}>{t(`migration_results.outcome_${block.outcome}`)}</Text> : null}
      {block.bodyAvailable ? <Button testID={`migration-branch-text-${block.index}`} variant="ghost" onPress={() => setSelection({ blockIndex: block.index, kind: "text" })}>{t("migration_results.read_text")}</Button> : null}
      {block.kind === "attachment" || block.kind === "tool_result" ? <Button testID={`migration-branch-attachment-${block.index}`} variant="ghost" disabled={!client.supports(block.kind === "attachment" ? "attachmentRead" : "toolAttachmentRead")} onPress={() => setSelection({ blockIndex: block.index, kind: block.kind as "attachment" | "tool_result" })}>{t(block.kind === "attachment" ? "migration_history.attachment" : "migration_history.tool_attachments")}</Button> : null}
    </View>)}
    <PageControls previous={pages.length > 1} next={read.result?.nextCursor != null} onPrevious={() => setPages(old => old.slice(0, -1))} onNext={() => { const next = read.result?.nextCursor; if (next != null) setPages(old => appendPage(old, next)); }}/>
  </View>;
}
function BranchText({ client, jobId, viewId, position, blockIndex }: { client: MobileMigrationClient; jobId: string; viewId: string; position: number; blockIndex: number }) {
  const styles = useThemedStyles(makeStyles), [pages, setPages] = useState<Array<string | null>>([null]);
  const read = useHistoricalRead(client, "branchText", { jobId, viewId, position, blockIndex, cursor: pages.at(-1) });
  return <View testID="migration-branch-text" style={styles.stack}><MigrationProblem code={read.error}/><ScrollView nestedScrollEnabled style={{ maxHeight: 320 }}><Text selectable style={styles.text}>{read.result?.text ?? ""}</Text></ScrollView><PageControls previous={pages.length > 1} next={!!read.result?.nextCursor} onPrevious={() => setPages(old => old.slice(0, -1))} onNext={() => { const next = read.result?.nextCursor; if (next) setPages(old => appendPage(old, next)); }}/></View>;
}
