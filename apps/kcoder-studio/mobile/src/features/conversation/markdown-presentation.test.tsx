import React, { cloneElement, type ReactElement } from 'react';
import { createRequire } from 'node:module';
import { expect, test, vi } from 'vitest';
import Markdown, { renderRules, type RenderRules } from 'react-native-markdown-display';
import { createConversationMarkdownRules } from './markdown-presentation';

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup(element: React.ReactNode): string };
vi.mock('react-native-fit-image', () => ({ default: () => null }));
vi.mock('lucide-react-native', () => ({}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

test.each(['classic', 'modern', 'v3'] as const)('%s preserves source line breaks, paragraphs and verbatim fenced code', version => {
  const seen: string[] = [];
  const overrides: RenderRules = {};
  for (const type of ['softbreak', 'hardbreak', 'paragraph']) {
    overrides[type] = (...args) => {
      seen.push(type);
      const result = renderRules[type]!(...args) as ReactElement<{ testID?: string }>;
      return cloneElement(result, { testID: `contract-${type}` });
    };
  }
  let code = '';
  overrides.fence = node => { code = node.content; return <span key={node.key}>{node.content}</span>; };
  const source = 'first\nsecond  \nthird\\\nfourth\n\nnext paragraph\n\n```text\n  indented  value\nunchanged\n```';
  const html = renderToStaticMarkup(<Markdown rules={createConversationMarkdownRules(version, overrides)}>{source}</Markdown>);
  expect(seen.filter(type => type === 'softbreak')).toHaveLength(1);
  expect(seen.filter(type => type === 'hardbreak')).toHaveLength(2);
  expect(seen.filter(type => type === 'paragraph')).toHaveLength(2);
  expect(html).toContain('data-testid="contract-softbreak">\n');
  expect(html).toContain('data-testid="contract-hardbreak">\n');
  expect(code).toBe('  indented  value\nunchanged\n');
});

test('the V3 version adapter keeps explicit message rules and V1/V2 keep the established block renderer', () => {
  const classic = createConversationMarkdownRules('classic');
  const modern = createConversationMarkdownRules('modern');
  expect(classic).toEqual(modern);
  const link = vi.fn(() => <span data-testid="custom-link">workspace action</span>);
  const html = renderToStaticMarkup(<Markdown rules={createConversationMarkdownRules('v3', { link })}>{'[File](https://example.com)'}</Markdown>);
  expect(link).toHaveBeenCalledOnce();
  expect(html).toContain('data-testid="custom-link"');
  expect(html).toContain('data-testid="conversation-markdown-block"');
});
