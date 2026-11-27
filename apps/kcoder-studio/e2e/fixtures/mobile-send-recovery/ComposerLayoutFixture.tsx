import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ListOrdered } from 'lucide-react-native';
import { ConversationV3Header } from '../../../mobile/src/features/interface/ConversationV3';
import { CachedTaskComposer, ComposerMetaRow, TaskComposer } from '../../../mobile/src/features/task/TaskComposer';
import { TaskSubagentComposer } from '../../../mobile/src/features/task/TaskSubagentConversation';
import { NewTaskDraft } from '../../../mobile/src/features/task/NewTaskDraft';
import { TaskExpertSelector } from '../../../mobile/src/features/task/TaskExpertSelector';
import { TaskPermissionSelector, canChangePermission } from '../../../mobile/src/features/task/TaskPermissionSelector';
import { TaskMenuSheet, TaskPermissionMenuItem } from '../../../mobile/src/features/task/TaskMenu';
import type { PermissionMode } from '../../../mobile/src/protocol/task-permission-mode';
import { LocalDraftAttachmentPreview } from '../../../mobile/src/features/task/TaskAttachments';
import { useTaskAppearance } from '../../../mobile/src/features/task/taskStyles';
import { t } from '../../../mobile/src/i18n';

const noop = () => {};
const asyncNoop = async () => {};
const expertChoice = { reference: { id: 'layout-expert', version: '1', definitionSha256: 'a'.repeat(64) }, title: 'Layout expert · 1' };
const otherExpertChoice = { ...expertChoice, reference: { ...expertChoice.reference, id: 'other-layout-expert' }, title: 'Other expert · 1' };
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANElEQVR4nGOQc1j/Hxn/nmSDgkV2LEPBbzxmomCGYWAAIQWELBgOBgx8LAy8AQMfCwNuAAAEdoRfJr60FQAAAABJRU5ErkJggg==';
const items = [
  { id: 'image', filename: 'layout.png', mimeType: 'image/png', fileSize: 120, previewUri: image },
  { id: 'file', filename: 'a-long-attachment-filename-for-the-layout-check.txt', mimeType: 'text/plain', fileSize: 1200 },
];

/** Real presentation components with frozen owners; no runtime, network or file access. */
export default function ComposerLayoutFixture() {
  const params = new URLSearchParams(location.search);
  const mode = params.get('layout') ?? 'idle';
  const english = params.get('language') === 'en';
  const { styles, colors } = useTaskAppearance();
  const owner = useRef({}).current;
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(mode === 'permissions-unsupported' ? 'ask' : 'default');
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [permissionRequest, setPermissionRequest] = useState<object>();
  const [expertRecovered, setExpertRecovered] = useState(false);
  const [selectedExpert, setSelectedExpert] = useState<typeof expertChoice | null>(null);
  const expertRetries = useRef<Array<{ resolve(): void; reject(error: Error): void }>>([]);
  useEffect(() => {
    // Fault completion is controlled by this fixture, never by a product route.
    const complete = (event: Event) => {
      const { index, outcome } = (event as CustomEvent<{ index: number; outcome: string }>).detail;
      const retry = expertRetries.current[index];
      if (!retry) throw new Error('Fixture expert retry is not pending');
      if (outcome === 'resolve') { setExpertRecovered(true); retry.resolve(); }
      else retry.reject(new Error('FIXTURE_OLD_RETRY_FAILED'));
    };
    window.addEventListener('fixture-expert-retry-complete', complete);
    return () => window.removeEventListener('fixture-expert-retry-complete', complete);
  }, []);
  const inputRef = useRef<TextInput>(null);
  const [input, setInput] = useState(mode === 'multiline' ? 'Line one\nLine two\nLine three\nLine four\nLine five\nLine six' : '');
  const running = ['running', 'queued', 'stopping', 'subagent-running', 'subagent-stopping'].includes(mode);
  const offline = mode === 'offline' || mode.startsWith('draft-offline');
  const busy = mode === 'sending' || mode === 'draft-busy';
  const modelLabel = 'MiniMax-M3.1-Flash · long model label';
  const snapshot = { threadId: 'layout-thread', title: 'Layout', cwd: '/workspace/layout',
    permissionMode, historyReadOnly: mode === 'permissions-readonly',
    connected: !offline, configurationReady: !offline, running, activeTurnId: running ? 'layout-turn' : null,
    ...(mode.endsWith('stopping') ? { stopRequestedTurnId: 'layout-turn' } : {}),
    messages: [], hasMoreBefore: false, beforeCursor: null, loadingOlder: false, interaction: null, error: null };
  const latestSnapshot = useRef(snapshot); latestSnapshot.current = snapshot;
  const permissionTask = useRef({ interrupt: asyncNoop, getSnapshot: () => latestSnapshot.current,
    isDisposed: () => false, supportsTurnPermissions: () => mode !== 'permissions-unsupported', setPermissionMode });
  const task = (mode.startsWith('permissions') ? permissionTask.current : { interrupt: asyncNoop, getSnapshot: () => snapshot }) as NonNullable<ComponentProps<typeof TaskComposer>['model']['task']>;
  const model = { task, snapshot, input, setInput, messageInputRef: inputRef, attachments: [], canSend: !offline && !busy && !snapshot.historyReadOnly && Boolean(input),
    submitting: busy, attachmentSheet: false, modelPickerOpen: false,
    failedSubmissions: ['failed', 'unknown', 'accepted'].includes(mode) ? [{
      id: 'layout-submission', content: 'Original unsent message', attachments: [], createdAt: 1,
      outcome: mode === 'failed' ? 'failed' : 'unknown', retrying: false,
      ...(mode === 'accepted' ? { acceptedTurn: { threadId: 'layout-thread', turnId: 'accepted-turn' } } : {}),
      error: english ? 'Example: the message could not be sent. Preserve the newer draft.' : '示例：消息发送失败，保留新的草稿。',
    }] : [],
    retainedOutbox: { rows: [], error: null, busy: [], available: false, resume: asyncNoop, checkConsumer: asyncNoop, discard: asyncNoop },
    removeAttachment: asyncNoop, openAttachmentSheet: noop, setQueueError: noop, setComposerNotice: noop,
    submit: asyncNoop, retryFailedSubmission: asyncNoop, checkFailedSubmission: asyncNoop,
    dismissFailedSubmission: noop, removeFailedSubmissionAttachment: asyncNoop,
    attachmentTransfers: mode.startsWith('upload') ? [{ id: 1, filename: items[1].filename,
      phase: mode === 'upload-failed' ? 'failed' : 'uploading', progress: 42, error: 'Example attachment upload failed. Retry from the attachment picker.' }] : [],
    cancelAttachmentTransfer: noop,
  } as ComponentProps<typeof TaskComposer>['model'];
  const count = Number(params.get('count') ?? '1');
  const toolbar = <ComposerMetaRow permissionSelector={null}
    modelSelector={<Pressable testID="conversation-model-selector" style={styles.modelSelectorMeta}><Text numberOfLines={1} style={styles.model}>{modelLabel}</Text></Pressable>}
    status={mode === 'queued' ? <Pressable testID="composer-notices-toggle" style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
      <ListOrdered size={20} color={colors.textMuted} /><View style={styles.composerQueueBadge}><Text style={styles.composerQueueBadgeText}>{count > 99 ? '99+' : count}</Text></View>
    </Pressable> : null} />;
  let composer;
  if (mode.startsWith('draft')) {
    const retryingExpert = mode === 'draft-expert-retry' && !expertRecovered;
    const expert = <TaskExpertSelector owner={owner} selection={mode === 'draft-expert-selection' ? selectedExpert : retryingExpert ? undefined : mode === 'draft-selected' || mode === 'draft-expert-selection-error' ? {
      reference: { id: 'layout-expert', version: '1', definitionSha256: 'a'.repeat(64) }, title: 'A long selected expert name',
    } : null} disabled={offline || busy} availability={retryingExpert ? 'error' : offline ? 'disconnected' : mode === 'draft-connecting' ? 'loading' : 'ready'}
      onRetryCurrent={() => new Promise<void>((resolve, reject) => { expertRetries.current.push({ resolve, reject }); })}
      loadExperts={async () => { if (mode === 'draft-expert-load-error') throw new Error('FIXTURE_INTERNAL_DIAGNOSTIC'); return {
        items: mode === 'draft-expert-selection' ? [{ id: 'layout-expert', title: 'Layout expert' }, { id: 'other-layout-expert', title: 'Other expert' }] : [], nextCursor: null }; }}
      loadVersions={async expertId => ({ items: mode === 'draft-expert-selection' ? [expertId === expertChoice.reference.id ? expertChoice : otherExpertChoice] : [], nextCursor: null })}
      onSelect={async selected => { if (mode === 'draft-expert-selection-error') throw new Error('FIXTURE_INTERNAL_DIAGNOSTIC token=fixture-only-secret');
        if (mode === 'draft-expert-selection') setSelectedExpert(selected); }} />;
    const waiting = ['draft-connecting', 'draft-loading', 'draft-confirm'].includes(mode);
    composer = <NewTaskDraft cwd="/workspace/layout" input={input} setInput={setInput} ready={!offline && !waiting} busy={busy}
      permissionMode={permissionMode} permissionsSupported={mode === 'draft-permissions'}
      onSelectPermission={mode === 'draft-permissions' ? setPermissionMode : undefined}
      modelLabel={modelLabel} reasoningEffort="high" bottomInset={0} modelPickerOpen={false} openModelPicker={noop}
      workspaceStatus={mode === 'draft-loading' ? t('new.draft_loading_options') : mode === 'draft-confirm' ? t('new.draft_confirm_project') : undefined}
      contextActual={{ scopeToken: owner, profileId: 'fixture', serverId: mode === 'draft-offline' ? '' : 'target', cwd: mode === 'draft-offline' ? '' : '/workspace/layout', projectLabel: 'Layout',
        connectionStatus: offline ? 'offline' : mode === 'draft-connecting' ? 'checking' : mode === 'draft-confirm' ? 'unknown' : 'online' }}
      submit={asyncNoop} draftEditable={mode !== 'draft-offline-locked'} expertSelector={expert} />;
  } else if (mode === 'cached' || mode === 'history') {
    composer = <CachedTaskComposer draft={input} model={modelLabel} bottomInset={0} offline={mode === 'cached'} onlineHistory={mode === 'history'} />;
  } else if (mode.startsWith('subagent')) {
    composer = <TaskSubagentComposer value={input} onChange={setInput} disabled={false} canSend={Boolean(input)}
      onSend={noop} label="Send instruction" running={running} bottomInset={0}
      stopAction={running ? { label: 'Stop', disabled: mode.endsWith('stopping'), onPress: noop } : undefined} />;
  } else {
    composer = <TaskComposer model={model} toolbar={toolbar} localAttachments={mode === 'attachments' ? {
      count: items.length, disabled: false, open: noop,
      preview: <LocalDraftAttachmentPreview items={items} disabled={false} onRemove={noop} />,
    } : undefined} />;
  }
  return <SafeAreaProvider><View testID="composer-layout-fixture" style={{ flex: 1, minHeight: 0, backgroundColor: colors.background }}>
    {mode.startsWith('draft') ? composer : <>
      <ConversationV3Header title={english ? 'Layout check' : '布局检查'} subtitle="Synthetic fixture" onBack={noop} onNew={noop}
        onMore={mode.startsWith('permissions') ? () => setPermissionMenuOpen(true) : noop} />
      <View style={{ flex: 1, minHeight: 0 }} /><View testID="fixture-composer-dock">{composer}</View>
    </>}
    {mode.startsWith('permissions') ? <>
      <TaskMenuSheet visible={permissionMenuOpen} onClose={() => setPermissionMenuOpen(false)} title={t('task.more')} testID="fixture-permission-menu">
        <TaskPermissionMenuItem disabled={!canChangePermission(task, model.snapshot)} permissionLabel={t('task.permission_mode_' + permissionMode)}
          onPress={() => { setPermissionMenuOpen(false); setPermissionRequest({}); }} />
      </TaskMenuSheet>
      <TaskPermissionSelector task={task} snapshot={model.snapshot} demo={false} hideTrigger openRequest={permissionRequest} />
    </> : null}
  </View></SafeAreaProvider>;
}
