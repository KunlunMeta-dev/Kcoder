import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui";
import { t } from "@/i18n";
import { useThemedStyles } from "@/theme";
import type { MigrationIssue } from "../../../../../shared/generated/contracts";
import { makeStyles, PageControls } from "./migration-result-ui";
export function MigrationIssues({ issues }: {
    issues: MigrationIssue[];
}) {
    const styles = useThemedStyles(makeStyles);
    const [open, setOpen] = useState(false);
    const [page, setPage] = useState(0);
    if (!issues.length)
        return null;
    const last = Math.max(0, Math.ceil(issues.length / 10) - 1);
    const current = Math.min(page, last);
    return <View>
    <Button variant="ghost" onPress={() => setOpen(value => !value)}>{t("migration_results.issue_count", { count: issues.length })}</Button>
    {open ? <>
      {issues.slice(current * 10, current * 10 + 10).map((issue, index) => <Text key={`${current}:${index}`} style={styles.warning}>{t(`migration_results.issue_${issue.code}`)}</Text>)}
      <PageControls previous={current > 0} next={current < last} onPrevious={() => setPage(current - 1)} onNext={() => setPage(current + 1)}/>
    </> : null}
  </View>;
}
