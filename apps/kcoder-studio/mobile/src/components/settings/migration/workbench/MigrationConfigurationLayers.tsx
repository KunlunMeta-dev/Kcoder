import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui";
import { t } from "@/i18n";
import { useThemedStyles } from "@/theme";
import type { MobileMigrationClient, MigrationCalls } from "@/runtime/migration-client";
import type { MigrationConfigurationLayersTarget } from "../../../../../../shared/generated/contracts";
import { makeStyles, PageControls } from "../migration-result-ui";
type Result = MigrationCalls["configurationLayers"][1];

export function MigrationConfigurationLayers({ client, target }: { client: MobileMigrationClient; target: MigrationConfigurationLayersTarget }) {
  const styles = useThemedStyles(makeStyles);
  const scope = JSON.stringify(target);
  const [opened, setOpened] = useState<{ client: MobileMigrationClient; scope: string } | null>(null);
  const [page, setPage] = useState({ scope, index: 0 });
  const [state, setState] = useState<{ client: MobileMigrationClient; scope: string; index: number; value?: Result; error?: boolean } | null>(null);
  const expanded = opened?.client === client && opened.scope === scope;
  const index = page.scope === scope ? page.index : 0;
  useEffect(() => {
    if (!expanded || !client.available()) return;
    let active = true;
    void client.call("configurationLayers", { target, pageIndex: index }).then(value => {
      if (active && client.available()) setState({ client, scope, index, value });
    }, () => { if (active && client.available()) setState({ client, scope, index, error: true }); });
    return () => { active = false; };
  }, [client, scope, index, expanded]);
  const current = state?.client === client && state.scope === scope && state.index === index && client.available() ? state : null;
  const value = current?.value;
  const move = (next: number) => { if (client.available()) { setState(null); setPage({ scope, index: next }); } };
  if (!client.supports("configurationLayers")) return null;
  return <View style={styles.stack} testID="migration-layer-report">
    <Button testID="migration-layer-toggle" variant="ghost" onPress={() => { if (client.available()) setOpened(expanded ? null : { client, scope }); }}>{t("migration_layers.title")}</Button>
    {expanded ? <View testID="migration-layer-details" style={styles.stack}>
      <Text style={styles.note}>{t("migration_layers.boundary")}</Text>
      {!current ? <Text style={styles.note}>{t("migration_layers.loading")}</Text> : null}
      {current?.error ? <Text accessibilityRole="alert" style={styles.error}>{t("migration_layers.failed")}</Text> : null}
      {value && value.status !== "available" ? <Text style={styles.note}>{t(`migration_layers.${value.status}`)}</Text> : null}
      {value?.status === "available" ? <>
        <Text style={styles.note}>{value.layers.map(layer => `${t(`migration_layers.${layer.scope}`)}: ${t(layer.present ? "migration_layers.present" : "migration_layers.absent")}`).join(" · ")}</Text>
        <Text style={styles.note}>{t("migration_layers.precedence")}</Text>
        {value.fields.map(field => <View key={field.ordinal} testID="migration-layer-field" style={styles.row}>
          <Text selectable style={styles.text}>{field.field ?? t("migration_layers.unknown", { n: field.ordinal + 1 })}</Text>
          <Text style={styles.note}>{t(field.supported ? "migration_layers.supported" : "migration_layers.unsupported")}{field.private ? ` · ${t("migration_layers.private")}` : ""}</Text>
          <Text style={styles.note}>{field.scopes.map(scope => t(`migration_layers.${scope}`)).join(" → ")}{field.supported ? ` · ${t("migration_layers.winner")}: ${t(`migration_layers.${field.scopes.at(-1)}`)}` : ""}</Text>
        </View>)}
        <Text style={styles.note}>{t("migration_layers.unobserved")}: {value.unobserved.map(name => t(`migration_layers.${name}`)).join("、")}</Text>
        <Text style={styles.note}>{t("migration_layers.page", { page: index + 1, total: value.totalFields })}</Text>
        <PageControls previous={index > 0} next={value.nextPage != null} onPrevious={() => move(index - 1)} onNext={() => { if (value.nextPage != null) move(value.nextPage); }}/>
      </> : null}
    </View> : null}
  </View>;
}
