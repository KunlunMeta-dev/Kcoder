import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, test, vi } from 'vitest';
import Markdown from 'react-native-markdown-display';
import { CodeDisclosure } from '@/components/output-disclosure';
import { createConversationMarkdownRules } from './markdown-presentation';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock('react-native-fit-image', () => ({ default: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('lucide-react-native', () => ({ Lightbulb: () => null, Wrench: () => null, ChevronDown: () => null, ChevronRight: () => null }));

const rules = createConversationMarkdownRules('v3', {
  fence: (node: { key: string; content: string }) => <CodeDisclosure key={node.key} content={node.content} language="typescript" />,
  code_block: (node: { key: string; content: string }) => <CodeDisclosure key={node.key} content={node.content} />,
});
const initial = '# Streaming\n\n```ts\nconst first = 1;\n```\n\nReceiving';

test.each([
  initial,
  '> Quoted\n>\n> ~~~ts\n> const first = 1;\n> ~~~\n\nReceiving',
  '- List item\n\n  ```ts\n  const first = 1;\n  ```\n\nReceiving',
  'Indented\n\n    const first = 1;\n\nReceiving',
])('an expanded code block stays mounted while later Markdown arrives: %s', async source => {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<Markdown rules={rules}>{source}</Markdown>); });
  const disclosure = () => renderer.root.findAllByType(CodeDisclosure)[0];
  const toggle = () => disclosure().findAll(node => typeof node.props.onPress === 'function')[0];
  await act(async () => toggle().props.onPress());
  expect(toggle().props['aria-expanded']).toBe(true);
  const mounted = disclosure();
  await act(async () => renderer.update(<Markdown rules={rules}>{source + ' the next paragraph.'}</Markdown>));
  expect(toggle().props['aria-expanded']).toBe(true);
  expect(disclosure()).toBe(mounted);
  await act(async () => renderer.unmount());
});

test('an open fence keeps its choice as code grows and closes, and later fences start collapsed', async () => {
  let renderer!: ReactTestRenderer;
  const source = '```ts\nconst first = 1;';
  await act(async () => { renderer = create(<Markdown rules={rules}>{source}</Markdown>); });
  const disclosure = (index = 0) => renderer.root.findAllByType(CodeDisclosure)[index];
  const toggle = (index = 0) => disclosure(index).findAll(node => typeof node.props.onPress === 'function')[0];
  await act(async () => toggle().props.onPress());
  const mounted = disclosure();
  for (const suffix of ['\nconst next = 2;', '\nconst next = 2;\n```\n\n```text\nsecond\n```']) {
    await act(async () => renderer.update(<Markdown rules={rules}>{source + suffix}</Markdown>));
    expect(toggle().props['aria-expanded']).toBe(true);
    expect(disclosure()).toBe(mounted);
  }
  expect(toggle(1).props['aria-expanded']).toBe(false);
  await act(async () => toggle().props.onPress());
  await act(async () => renderer.update(<Markdown rules={rules}>{source + '\n```\n\nDone.'}</Markdown>));
  expect(toggle().props['aria-expanded']).toBe(false);
  await act(async () => renderer.unmount());
});

test('identical Markdown trees keep independent choices across rule and style rerenders', async () => {
  let renderer!: ReactTestRenderer;
  const pair = (style = {}) => <>
    <Markdown key="first" rules={rules} style={style}>{initial}</Markdown>
    <Markdown key="second" rules={createConversationMarkdownRules('v3', { fence: rules.fence })}>{initial}</Markdown>
  </>;
  await act(async () => { renderer = create(pair()); });
  const toggles = () => renderer.root.findAllByType(CodeDisclosure).map(node => node.findAll(child => typeof child.props.onPress === 'function')[0]);
  await act(async () => toggles()[0].props.onPress());
  await act(async () => renderer.update(pair({ body: { color: '#333333' } })));
  expect(toggles().map(node => node.props['aria-expanded'])).toEqual([true, false]);
  await act(async () => renderer.unmount());
});
