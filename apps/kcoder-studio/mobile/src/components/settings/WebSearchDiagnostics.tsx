import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import type { WebSearchProbeResult, WebSearchStatusReadResult } from '../../../../shared/generated/contracts';
import { MobileWebSearchDiagnostics } from '@/gateway/web-search';
import { WEB_SEARCH_METHODS, webSearchProbeRejection } from '../../../../shared/webSearchMethods.mjs';
import { useSettingsTarget } from './SettingsTargetContext';
import { t } from '@/i18n';
import { spacing, useTheme, useThemedStyles, type ThemeColors } from '@/theme';

/** Optional diagnostics in the existing tools page; this never enables a tool. */
export function WebSearchDiagnostics() {
  const target = useSettingsTarget();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const active = useRef(true);
  const generation = useRef(0);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'kcoder' | 'kworker'>('kcoder');
  const [status, setStatus] = useState<WebSearchStatusReadResult | null>(null);
  const [probe, setProbe] = useState<WebSearchProbeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const owned = useRef<{ requestId: string; expectedRevision: string } | null>(null);
  const client = new MobileWebSearchDiagnostics({
    request: target.request,
    supportsExperimental: name => target.capabilities.appServer?.experimental?.[name] === true,
  }, () => active.current && target.ready);
  const current = (request: number) => active.current && request === generation.current;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current++;
      if (owned.current) void target.request(WEB_SEARCH_METHODS.cancel, owned.current).catch(() => {});
    };
  }, [target.request]);
  async function load(nextMode = mode) {
    const request = ++generation.current;
    setBusy(true); setNotice(''); setStatus(null); setProbe(null); setMode(nextMode);
    try {
      const result = await client.status({ mode: nextMode });
      if (current(request)) setStatus(result);
    } catch { if (current(request)) setNotice('unsupported'); }
    finally { if (current(request)) setBusy(false); }
  }
  async function check(read = false) {
    if (!status || (busy && !read)) return;
    const request = ++generation.current;
    const binding = owned.current ?? { requestId: `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`, expectedRevision: status.revision };
    owned.current = binding;
    setBusy(true); setNotice('');
    try {
      let result: WebSearchProbeResult;
      try { result = read ? await client.read(binding) : await client.start({ ...binding, mode }); }
      catch (error) {
        const rejection = read ? null : webSearchProbeRejection(error);
        if (rejection) {
          if (current(request)) { owned.current = null; setNotice(rejection === 'policy_denied' ? 'errors.policy_denied' : rejection === 'unsupported' ? 'unsupported' : 'failed'); }
          return;
        }
        result = await client.read(binding);
      }
      for (let attempt = 0; current(request) && attempt < 120; attempt++) {
        if (result.targetId !== status.targetId || result.revision !== status.revision || result.requestId !== binding.requestId) throw new Error('SEARCH_BINDING_CONFLICT');
        setProbe(result);
        if (result.state !== 'running') {
          if (result.state !== 'unknown') owned.current = null;
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        if (!current(request)) return;
        result = await client.read(binding);
      }
    } catch { if (current(request)) setNotice('unknown'); }
    finally { if (current(request)) setBusy(false); }
  }
  async function cancel() {
    if (!owned.current || !status) return;
    const request = ++generation.current;
    setBusy(true); setNotice('stopping');
    try {
      const result = await client.cancel(owned.current);
      if (current(request) && result.targetId === status.targetId && result.revision === status.revision && result.requestId === owned.current.requestId) {
        setProbe(result); setNotice(''); if (result.state !== 'unknown') owned.current = null;
      }
    } catch { if (current(request)) setNotice('unknown'); }
    finally { if (current(request)) setBusy(false); }
  }
  const outcome = probe?.state === 'completed' ? probe.response?.status ?? 'unknown' : probe?.state;
  const action = (label: string, run: () => void, disabled = false) => <Pressable accessibilityRole="button" disabled={disabled} onPress={run} style={styles.action}><Text style={[styles.text, disabled && styles.disabled]}>{t(`web_search.${label}`)}</Text></Pressable>;
  return <View style={styles.root} testID="web-search-diagnostics">
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => { setOpen(!open); if (!open && !status) void load(); }} style={styles.header}>
      <ChevronRight size={16} color={colors.textMuted} style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }} /><Text style={styles.text}>{t('web_search.details')}</Text>
    </Pressable>
    {open && <View style={styles.body}>
      <View style={styles.actions}>{(['kcoder', 'kworker'] as const).map(item => <Pressable key={item} accessibilityRole="button" accessibilityState={{ selected: mode === item }} disabled={busy || Boolean(owned.current)} onPress={() => void load(item)} style={styles.action}><Text style={styles.text}>{item === 'kcoder' ? 'KCoder' : 'KWorker'}</Text></Pressable>)}</View>
      {busy ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
      {status && <>
        <Text style={styles.text}>{t(`web_search.${status.webSearchVisible ? status.candidates.length === 0 ? 'source_restricted' : status.automatic ? 'automatic' : 'specified' : 'restricted'}`)}</Text>
        <Text selectable style={styles.note}>{status.candidates.join(' → ')}</Text>
        {status.observations.filter(item => status.candidates.includes(item.provider)).map(item => <Text key={item.provider} style={styles.note}>{item.provider}: {t(item.status ? `web_search.observed.${item.status}` : `web_search.${item.component === 'unavailable' ? 'component_unavailable' : 'unobserved'}`)}</Text>)}
        <Text style={styles.note}>{t('web_search.probe_notice')}</Text>
        {outcome ? <Text accessibilityLiveRegion="polite" style={styles.text}>{t(`web_search.${outcome}`, { p0: probe?.response?.page.results.length ?? 0 })}</Text> : null}
        {probe?.response?.failure ? <Text style={styles.note}>{t(`web_search.errors.${probe.response.failure}`)}</Text> : null}
        <View style={styles.actions}>{target.capabilities.appServer?.experimental?.webSearchProbeV1 === true ? action('check', () => void check(), busy || Boolean(owned.current) || !status.webSearchVisible) : null}{owned.current ? <>{action('refresh', () => void check(true), busy)}{action('cancel', () => void cancel())}</> : action('refresh', () => void load(), busy)}</View>
      </>}
      {notice ? <Text accessibilityRole="alert" style={styles.note}>{t(`web_search.${notice}`)}</Text> : null}
    </View>}
  </View>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  header: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  body: { gap: spacing.sm }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  action: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.sm },
  text: { color: colors.text, fontSize: 14 }, note: { color: colors.textMuted, fontSize: 13 }, disabled: { opacity: 0.4 },
});
