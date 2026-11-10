import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, test, vi } from 'vitest';
import { MarkdownIt, stringToTokens, tokensToAST, type ASTNode } from 'react-native-markdown-display';
import { MarkdownTable } from './MarkdownTable';
import { tableToMarkdown } from './markdown-table-content';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const clipboard = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<boolean>>());
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboard }));
vi.mock('react-native-fit-image', () => ({ default: () => null }));
vi.mock('lucide-react-native', () => ({ Check: () => null, Copy: () => null, Maximize2: () => null, MoreHorizontal: () => null, X: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/components/use-modal-focus-trap', () => ({ useModalFocusTrap: () => null }));

const node = (value: string): ASTNode => tokensToAST(stringToTokens(`| Name |\n| --- |\n| ${value} |`, new MarkdownIt()))[0];
const styles = { tableFrame: {}, _VIEW_SAFE_table: {} };
const table = (value: ASTNode) => <MarkdownTable node={value} styles={styles}>{[]}</MarkdownTable>;
const control = (renderer: ReactTestRenderer, testID: string) => renderer.root.findAll(instance => instance.props.testID === testID && typeof instance.props.onPress === 'function')[0];

test('clipboard denial gives local feedback and an enabled retry that can succeed', async () => {
  clipboard.mockReset().mockRejectedValueOnce(new Error('denied')).mockResolvedValueOnce(true);
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(table(node('Selected'))); });
  await act(async () => control(renderer, 'markdown-table-copy').props.onPress());
  expect(renderer.root.findAll(instance => instance.props.testID === 'markdown-table-feedback')[0].props.children).toMatch(/失败|failed/);
  expect(control(renderer, 'markdown-table-copy').props.disabled).toBe(false);
  await act(async () => control(renderer, 'markdown-table-copy').props.onPress());
  expect(renderer.root.findAll(instance => instance.props.testID === 'markdown-table-feedback')[0].props.children).toMatch(/已复制|copied/);
  expect(clipboard.mock.calls[0][0]).toBe(tableToMarkdown(node('Selected')));
  await act(async () => renderer.unmount());
});

test('a pending copy cannot duplicate and its receipt cannot claim newer table content was copied', async () => {
  let finish!: (value: boolean) => void;
  clipboard.mockReset().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(table(node('Before'))); });
  await act(async () => { control(renderer, 'markdown-table-copy').props.onPress(); control(renderer, 'markdown-table-copy').props.onPress(); });
  expect(clipboard).toHaveBeenCalledTimes(1);
  expect(control(renderer, 'markdown-table-copy').props.disabled).toBe(true);
  await act(async () => renderer.update(table(node('After'))));
  await act(async () => finish(true));
  expect(renderer.root.findAll(instance => instance.props.testID === 'markdown-table-feedback')[0].props.children).not.toMatch(/已复制|copied/);
  expect(control(renderer, 'markdown-table-copy').props.disabled).toBe(false);
  await act(async () => renderer.unmount());
});
