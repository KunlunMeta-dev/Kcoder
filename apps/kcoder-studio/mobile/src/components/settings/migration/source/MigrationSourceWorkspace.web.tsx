import { useCallback, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/components/ui';
import { t } from '@/i18n';
import { useThemedStyles } from '@/theme';
import { Sha256Stream } from '@/protocol/sha256-stream';
import { settingsTargetIdentity } from '@/runtime/settings-target';
import { useSettingsTarget } from '../../SettingsTargetContext';
import type { GatewayProfile, KCoderServer } from '@/gateway/types';
import type { SourceUploadState } from '../../../../../../shared/generated/contracts';
import { makeStyles } from '../migration-result-ui';
import { MigrationUploadPanel } from './MigrationUploadPanel.web';
import { MigrationProductPanel } from './MigrationProductPanel.web';
import { MigrationSourceBrowser } from './MigrationSourceBrowser.web';
import { MigrationTransferRecords } from './MigrationTransferRecords.web';
import type { MigrationSourceWorkspaceProps } from './MigrationSourceWorkspace.types';

export function MigrationSourceWorkspace(props: MigrationSourceWorkspaceProps) {
  const selected = useSettingsTarget();
  if (!selected.ready || !selected.profile || !selected.server || !selected.targetIdentity) return <Text>{t('migration_results.select_target')}</Text>;
  return <OwnedSourceWorkspace key={selected.targetIdentity} {...props} profile={selected.profile} server={selected.server} servers={selected.servers} workspacePath={selected.workspacePath} identity={selected.targetIdentity}/>;
}
function OwnedSourceWorkspace({ client, onJob, profile: original, server, servers, workspacePath, identity }: MigrationSourceWorkspaceProps & { profile: GatewayProfile; server: KCoderServer; servers: KCoderServer[]; workspacePath?: string; identity: string }) {
  const styles = useThemedStyles(makeStyles);
  const [profile] = useState(original), [mode, setMode] = useState<'upload' | 'remote'>('upload'), [sourceId, setSourceId] = useState<string | null>(null);
  const target = useMemo(() => ({ id: server.id, ...(workspacePath === undefined ? {} : { workspacePath }) }), [server.id, workspacePath]);
  const scope = useMemo(() => new Sha256Stream().update(new TextEncoder().encode(identity)).digestHex(), [identity]);
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  const isCurrent = useCallback(() => client.available() && currentIdentity.current === identity, [client, identity]);
  const [upload, setUpload] = useState<SourceUploadState | null>(null), [product, setProduct] = useState<SourceUploadState | null>(null);
  const rawIdentity = useCallback((id: string | null) => { setUpload(value => value?.operationId === id ? value : null); setProduct(value => value?.operationId === id ? value : null); }, []);
  const unavailable = useCallback((id: string) => setProduct(value => value?.operationId === id ? null : value), []);
  const ready = useCallback((value: SourceUploadState) => setUpload(old => old?.operationId === value.operationId && old.manifestSha256 === value.manifestSha256 ? old : value), []);
  const inspect = useCallback((value: SourceUploadState) => setProduct(old => old?.operationId === value.operationId && old.manifestSha256 === value.manifestSha256 ? old : value), []);
  const source = servers.find(value => value.id === sourceId), sourceIdentity = source ? settingsTargetIdentity(profile, source, source.workspacePath) : '';
  const sourceTarget = useMemo(() => source ? { id: source.id, ...(source.workspacePath === undefined ? {} : { workspacePath: source.workspacePath }) } : null, [sourceIdentity]);
  return <View style={styles.stack} testID="migration-source-workspace">
    <Text style={styles.title}>{t('migration_source.title')}</Text><Text style={styles.note}>{t('migration_source.boundary')}</Text>
    <View style={styles.actions}><Button testID="migration-source-upload-mode" variant={mode === 'upload' ? 'secondary' : 'ghost'} onPress={() => setMode('upload')}>{t('migration_source_upload.title')}</Button><Button testID="migration-source-remote-mode" variant={mode === 'remote' ? 'secondary' : 'ghost'} onPress={() => setMode('remote')}>{t('migration_source.remote')}</Button></View>
    {mode === 'upload' ? <>
      <MigrationUploadPanel client={client} scope={scope} isCurrent={isCurrent} onReady={ready} onIdentity={rawIdentity}/>
      {upload ? <MigrationProductPanel key={`${upload.operationId}:${upload.manifestSha256}`} client={client} scope={scope} upload={upload} isCurrent={isCurrent} onInspect={inspect} onUnavailable={unavailable}/> : null}
      {product ? <MigrationSourceBrowser key={`${product.operationId}:${product.manifestSha256}`} client={client} profile={profile} scope={scope} target={target} sourceTarget={target} uploaded={product} isCurrent={isCurrent} onJob={onJob}/> : null}
    </> : <>
      <Text style={styles.note}>{t('migration_source.choose_device')}</Text>
      <View style={styles.actions}>{servers.map(value => <Button key={value.id} testID={`source-device-${value.id}`} variant={sourceId === value.id ? 'secondary' : 'ghost'} onPress={() => setSourceId(value.id)}>{value.label || value.id}</Button>)}</View>
      {sourceTarget ? <MigrationSourceBrowser key={sourceIdentity} client={client} profile={profile} scope={scope} target={target} sourceTarget={sourceTarget} isCurrent={isCurrent} onJob={onJob}/> : null}
    </>}
    <MigrationTransferRecords client={client} profile={profile} scope={scope} target={target} isCurrent={isCurrent} onJob={onJob}/>
  </View>;
}
