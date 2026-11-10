import { beforeEach, expect, it, vi } from 'vitest';
vi.mock("@/components/settings/SettingsTargetContext", () => ({ useSettingsTarget() { throw new Error("Project target selection is outside this non-project fixture"); } }));
const hooks = vi.hoisted(() => ({ states: [] as any[], index: 0 }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useCallback: (callback: any) => callback, useState: (initial: any) => { const i = hooks.index++; if (!(i in hooks.states)) hooks.states[i] = initial; return [hooks.states[i], (value: any) => { hooks.states[i] = typeof value === 'function' ? value(hooks.states[i]) : value; }]; } }));
vi.mock('@/theme', () => ({ useThemedStyles: () => ({}) }));
vi.mock('@/i18n', () => ({ t: (key: string) => key }));
import { MobileMigrationClient } from '@/runtime/migration-client';
import { MigrationItemEditor } from '../workbench/MigrationItemEditor';
import { migrationMemoryEn } from '@/i18n/locales/migration-memory.en';
import { migrationMemoryZhCN } from '@/i18n/locales/migration-memory.zh-CN';
function find(tree: any, id: string): any {
  if (!tree || typeof tree !== 'object') return null;
  if (tree.props?.testID === id) return tree;
  for (const child of [tree.props?.children].flat(Infinity)) { const found = find(child, id); if (found) return found; }
  return null;
}
const transport = vi.fn();
const client = (workspace?: string) => new MobileMigrationClient(transport, { migrationAssetsV1: true, migrationMemoryV1: true }, { read: async () => [], put: async () => {} }, () => true, workspace);
const page = { items: [{ id: 'memory', category: 'memory', sourceName: 'source notes', status: 'requires_action', selectedByDefault: false, issues: [] }], assets: [{ itemId: 'memory' }], drafts: [{ itemId: 'memory', targetName: 'notes', choice: null }] };
function render(c: MobileMigrationClient, save = vi.fn()) { hooks.index = 0; return MigrationItemEditor({ client: c, jobId: 'owned', page: page as never, itemId: 'memory', choices: [], onSave: save, onClose() {} }); }
beforeEach(() => { hooks.states = []; hooks.index = 0; transport.mockClear(); });
it('requires explicit mapping and saves inactive notes without interpreting source labels as a target', () => {
  const c = client('/owned'), save = vi.fn();
  let tree = render(c, save);
  expect(find(tree, 'migration-item-save').props.disabled).toBe(true);
  expect(find(tree, 'migration-item-enable')).toBeNull();
  find(tree, 'migration-memory-map-global').props.onPress(); tree = render(c, save);
  expect(find(tree, 'migration-item-save').props.disabled).toBe(false);
  find(tree, 'migration-item-save').props.onPress();
  expect(save).toHaveBeenCalledWith({ choice: { kind: 'asset', itemId: 'memory', targetName: 'notes', memoryMapping: 'global', enableAfterImport: false } });
  expect(transport).not.toHaveBeenCalled();
});
it('never offers a missing destination workspace as a usable project mapping', () => {
  const c = client(); const tree = render(c);
  expect(find(tree, 'migration-memory-map-current_workspace').props.disabled).toBe(true);
  find(tree, 'migration-memory-map-global').props.onPress();
  expect(find(render(c), 'migration-item-save').props.disabled).toBe(false);
});
it('ships matching English and Chinese memory copy and interpolation fields', () => {
  expect(Object.keys(migrationMemoryEn).sort()).toEqual(Object.keys(migrationMemoryZhCN).sort());
  for (const key of Object.keys(migrationMemoryEn) as Array<keyof typeof migrationMemoryEn>) {
    const fields = (text: string) => [...text.matchAll(/\{([^}]+)\}/g)].map(m => m[1]).sort();
    expect(fields(migrationMemoryEn[key])).toEqual(fields(migrationMemoryZhCN[key]));
    expect(migrationMemoryZhCN[key]).not.toBe('');
  }
});
