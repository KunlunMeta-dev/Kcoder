import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, type ScrollViewInstance, type ViewStyle } from 'react-native';
import { Check, Copy, Maximize2, MoreHorizontal, X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ASTNode } from 'react-native-markdown-display';
import { useModalFocusTrap } from '@/components/use-modal-focus-trap';
import { t } from '@/i18n';
import { useLocale } from '@/i18n/use-locale';
import { radius, spacing, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { tableColumnCount, tableToMarkdown } from './markdown-table-content';

type ReadingStyles = Record<string, ViewStyle>;
type TableProps = { node: ASTNode; styles: ReadingStyles; children: ReactNode[] };
type Panel = 'expanded' | 'menu';

function TableViewport({ node, styles, children, fullscreen = false }: TableProps & { fullscreen?: boolean }) {
  const [width, setWidth] = useState(0);
  const viewport = useRef<ScrollViewInstance>(null);
  const minWidth = tableColumnCount(node) * 128;
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const host = viewport.current?.getScrollableNode() as HTMLElement | undefined;
    if (!host) return;
    // Keep horizontal gestures within the table, including in the inverted transcript.
    const horizontalWheel = (event: WheelEvent) => {
      if ((Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey && event.deltaY !== 0) && host.scrollWidth > host.clientWidth) event.stopPropagation();
    };
    const overscroll = host.style.overscrollBehaviorX;
    host.style.overscrollBehaviorX = 'contain';
    host.addEventListener('wheel', horizontalWheel, { passive: true });
    return () => { host.removeEventListener('wheel', horizontalWheel); host.style.overscrollBehaviorX = overscroll; };
  }, []);
  return <View testID={fullscreen ? 'markdown-table-expanded-frame' : 'conversation-markdown-table-scroll'} style={{ minWidth: 0, maxWidth: '100%' }}
    onLayout={event => { const next = Math.round(event.nativeEvent.layout.width); setWidth(previous => previous === next ? previous : next); }}>
    <ScrollView ref={viewport} horizontal nestedScrollEnabled testID={fullscreen ? 'markdown-table-expanded-viewport' : 'conversation-markdown-table-viewport'} showsHorizontalScrollIndicator
      {...(Platform.OS === 'web' ? { tabIndex: 0 as const } : {})}
      accessibilityLabel={t('task.reading_table')} accessibilityHint={minWidth > width ? t('task.reading_table_scroll') : undefined}
      style={{ maxWidth: '100%' }} contentContainerStyle={{ minWidth: '100%' }}>
      <View testID={fullscreen ? 'markdown-table-expanded-content' : 'conversation-markdown-table'} style={[styles._VIEW_SAFE_table, { width: Math.max(width, minWidth) }]}>{children}</View>
    </ScrollView>
  </View>;
}

function TablePanel({ mode, onClose, children, title, actions }: { mode: Panel; onClose(): void; children: ReactNode; title?: string; actions?: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const surface = useModalFocusTrap(true, onClose);
  const full = mode === 'expanded';
  return <View style={[styles.modalRoot, full && styles.fullRoot]}>
    {!full && <Pressable testID="markdown-table-menu-overlay" accessibilityLabel={t('common.close')} style={styles.overlay} onPress={onClose} />}
    <View ref={surface} role="dialog" accessibilityViewIsModal accessibilityLabel={t(full ? 'task.table_expanded' : 'task.table_more')}
      testID={full ? 'markdown-table-expanded' : 'markdown-table-menu'}
      style={[full ? styles.fullPanel : styles.sheet, { paddingTop: full ? insets.top : spacing.md, paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
      <View style={styles.panelHeader}>
        <Text accessibilityRole="header" accessibilityLiveRegion="polite" style={styles.panelTitle}>{title ?? t(full ? 'task.reading_table' : 'task.table_more')}</Text>
        {actions}
        <Pressable testID="markdown-table-panel-close" accessibilityRole="button" accessibilityLabel={t('common.close')}
          onPress={onClose} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
          <X size={20} color={colors.textMuted} />
        </Pressable>
      </View>
      {children}
    </View>
  </View>;
}

/** V3-only table chrome; the Markdown library still owns cell rendering. */
export function MarkdownTable({ node, styles: readingStyles, children }: TableProps) {
  useLocale();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ source: string; success: boolean } | null>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const markdown = useMemo(() => tableToMarkdown(node), [node]);
  const current = useRef(markdown);
  current.current = markdown;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const result = feedback?.source === markdown ? feedback : null;
  const copy = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setFeedback(null);
    let success = false;
    try {
      const Clipboard = await import('expo-clipboard');
      success = await Clipboard.setStringAsync(markdown);
    } catch { /* Clipboard denial remains local to this table. */ }
    finally {
      inFlight.current = false;
      if (mounted.current) {
        setPending(false);
        if (current.current === markdown) setFeedback({ source: markdown, success });
      }
    }
  };
  const copyButton = (fullscreen = false) => <Pressable testID={fullscreen ? 'markdown-table-expanded-copy' : 'markdown-table-copy'}
    accessibilityRole="button" accessibilityLabel={t('task.table_copy')} accessibilityState={{ disabled: pending, busy: pending }} disabled={pending}
    onPress={() => void copy()} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed, pending && styles.disabled]}>
    {result?.success ? <Check size={18} color={colors.textMuted} /> : <Copy size={18} color={colors.textMuted} />}
  </Pressable>;
  const feedbackText = t(result ? result.success ? 'task.table_copied' : 'task.table_copy_failed' : 'task.reading_table');
  const feedbackLabel = <Text testID="markdown-table-feedback" accessibilityLiveRegion="polite" numberOfLines={1}
    style={[styles.label, result?.success === false && styles.error]}>{feedbackText}</Text>;
  return <>
    <View testID="markdown-table-card" style={readingStyles.tableFrame}>
      <View testID="markdown-table-toolbar" style={styles.toolbar}>
        {feedbackLabel}
        {copyButton()}
        <Pressable testID="markdown-table-expand" accessibilityRole="button" accessibilityLabel={t('task.table_expand')}
          onPress={() => setPanel('expanded')} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
          <Maximize2 size={18} color={colors.textMuted} />
        </Pressable>
        <Pressable testID="markdown-table-more" accessibilityRole="button" accessibilityLabel={t('task.table_more')}
          accessibilityState={{ expanded: panel === 'menu' }} onPress={() => setPanel('menu')}
          style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
          <MoreHorizontal size={20} color={colors.textMuted} />
        </Pressable>
      </View>
      <TableViewport node={node} styles={readingStyles}>{children}</TableViewport>
    </View>
    {panel && <Modal visible transparent={panel === 'menu'} animationType={Platform.OS === 'web' ? 'none' : 'slide'}
      onRequestClose={() => setPanel(null)} accessibilityLabel={t(panel === 'expanded' ? 'task.table_expanded' : 'task.table_more')}>
      <TablePanel mode={panel} onClose={() => setPanel(null)} title={panel === 'expanded' ? feedbackText : undefined} actions={panel === 'expanded' ? copyButton(true) : undefined}>
        {panel === 'expanded' ? <>
          <ScrollView testID="markdown-table-expanded-scroll" style={styles.fullScroll} contentContainerStyle={styles.fullContent}>
            <View style={readingStyles.tableFrame}><TableViewport fullscreen node={node} styles={readingStyles}>{children}</TableViewport></View>
          </ScrollView>
        </> : <View style={styles.menuItems}>
          {/* TODO: Implement table image export and sharing before enabling these actions. */}
          {['image', 'share'].map(action => <Pressable key={action} testID={`markdown-table-${action}-todo`} accessibilityRole="button"
            disabled accessibilityState={{ disabled: true }} style={styles.menuItem}>
            <Text style={styles.todoText}>{t(action === 'image' ? 'task.table_image_todo' : 'task.table_share_todo')}</Text>
          </Pressable>)}
        </View>}
      </TablePanel>
    </Modal>}
  </>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  toolbar: { flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingHorizontal: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surfaceHover },
  label: { flex: 1, minWidth: 0, paddingHorizontal: spacing.sm, fontSize: 13, color: colors.textMuted },
  iconButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  pressed: { backgroundColor: colors.border },
  disabled: { opacity: 0.6 },
  error: { color: colors.red },
  modalRoot: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
  fullRoot: { backgroundColor: colors.background },
  overlay: { ...StyleSheet.absoluteFill, backgroundColor: colors.overlay },
  sheet: { width: '100%', maxWidth: 720, borderTopLeftRadius: radius.settingsGroup, borderTopRightRadius: radius.settingsGroup, paddingHorizontal: spacing.lg, backgroundColor: colors.surfaceRaised },
  fullPanel: { flex: 1, width: '100%', backgroundColor: colors.background },
  panelHeader: { flexDirection: 'row', alignItems: 'center', paddingLeft: spacing.lg, paddingRight: spacing.xs, minHeight: 48 },
  panelTitle: { flex: 1, minWidth: 0, fontSize: 17, fontWeight: '600', color: colors.text },
  fullScroll: { flex: 1, minHeight: 0 },
  fullContent: { padding: spacing.lg },
  menuItems: { paddingBottom: spacing.sm },
  menuItem: { minHeight: 48, justifyContent: 'center', paddingHorizontal: spacing.lg },
  todoText: { fontSize: 16, color: colors.textMuted },
});
