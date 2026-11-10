import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { Button, Field } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import type { MobileMigrationClient } from '@/runtime/migration-client';
import { AgentChoiceController } from '../../../../../../shared/migrationAgents';
import type { MigrationAgentAdaptation } from '../../../../../../shared/generated/contracts';
import { makeStyles } from '../migration-result-ui';
import { Check } from './WorkbenchUi';
export function MigrationAgentChoice({ client, jobId, itemId, initial, onChange }: { client: MobileMigrationClient; jobId: string; itemId: string; initial?: MigrationAgentAdaptation | null; onChange(value: MigrationAgentAdaptation | null, ready: boolean): void }) {
  const styles = useThemedStyles(makeStyles);
  const controller = useMemo(() => new AgentChoiceController({ agentPreview: p => client.call('agentPreview', p) }, { jobId, itemId }, () => client.available(), initial), [client, jobId, itemId, initial]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  useEffect(() => { controller.activate(); return controller.dispose; }, [controller]);
  useEffect(() => { onChange(controller.value(), controller.ready()); }, [controller, state, onChange]);
  return <View style={styles.stack} testID="migration-agent-choice"><Check testID="migration-agent-adapt" checked={state.enabled} disabled={!client.supports('agentPreview')} onPress={() => controller.change({ enabled: !state.enabled })} label={t('migration_agents.adapt')}/>
    {!client.supports('agentPreview') ? <Text style={styles.note}>{t('migration_agents.update_required')}</Text> : null}
    {state.enabled ? <><Text style={styles.note}>{t('migration_agents.boundary')}</Text><Button testID="migration-agent-inspect" disabled={state.busy} onPress={() => { void controller.read(); }}>{t('migration_agents.inspect')}</Button>
      {state.error ? <Text accessibilityRole="alert" style={styles.error}>{t(state.error === 'updateRequired' ? 'migration_agents.update_required' : 'migration_agents.failed')}</Text> : null}
      {state.result && !state.result.compatibility.canAdapt ? <Text style={styles.warning}>{t('migration_agents.unsupported')}</Text> : null}
      {state.result?.compatibility.canAdapt ? <><Text style={styles.text}>{t('migration_agents.model')}</Text><View style={styles.actions}>{(['inherit', 'target'] as const).map(kind => <Button key={kind} testID={`migration-agent-model-${kind}`} variant={state.kind === kind ? 'secondary' : 'ghost'} onPress={() => controller.change({ kind })}>{t(`migration_agents.${kind}`)}</Button>)}</View>
        {state.kind === 'target' ? <>{(['provider', 'model'] as const).map(key => <Field key={key} testID={`migration-agent-${key}`} label={t(`migration_agents.${key}`)} value={state[key]} onChangeText={value => controller.change({ [key]: value })} maxLength={256} autoCapitalize="none" autoCorrect={false}/>)}</> : null}
        <Text style={styles.note}>{t('migration_agents.model_boundary')}</Text><Text style={styles.text}>{t('migration_agents.tools')}</Text>{state.result.compatibility.availableTools.map(tool => <Check key={tool} testID={`migration-agent-tool-${tool}`} checked={state.tools.includes(tool)} onPress={() => controller.change({ tools: state.tools.includes(tool) ? state.tools.filter(value => value !== tool) : [...state.tools, tool] })} label={tool}/>)}
        <Check testID="migration-agent-confirm" checked={state.confirmed} onPress={() => controller.confirm(!state.confirmed)} label={t('migration_agents.confirm')}/></> : null}
    </> : null}
  </View>;
}
