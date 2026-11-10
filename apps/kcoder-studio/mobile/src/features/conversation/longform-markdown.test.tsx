import React from 'react';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import Markdown from 'react-native-markdown-display';
import { darkColors, lightColors } from '@/theme';
import { createTaskMarkdownStyles } from '@/features/task/taskStyles';
import { longformMarkdownRules, readingBlockStyle } from './longform-markdown-rules';

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup(element: React.ReactNode): string };
vi.mock('react-native-fit-image', () => ({ default: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('lucide-react-native', () => ({ Check: () => null, Copy: () => null, Maximize2: () => null, MoreHorizontal: () => null, X: () => null }));

describe('V3 long-form Markdown', () => {
  it.each(['compact', 'normal', 'relaxed'] as const)('gives the block stack sole ownership of %s spacing', blockSpacing => {
    const styles = createTaskMarkdownStyles(lightColors, 'normal', 'normal', blockSpacing, 'normal', undefined, undefined, 'v3');
    if (!('readingBlock' in styles && 'readingSection' in styles && 'readingHeadingBody' in styles)) throw new Error('V3 must provide its block-spacing recipe');
    const gaps = { readingBlock: styles.readingBlock, readingSection: styles.readingSection, readingHeadingBody: styles.readingHeadingBody };
    expect(styles.body.gap).toBe(0);
    expect(styles.paragraph).toMatchObject({ marginTop: 0, marginBottom: 0 });
    expect(readingBlockStyle('heading1', undefined, gaps)).toEqual({ marginTop: 0 });
    const paragraphGap = readingBlockStyle('paragraph', 'paragraph', gaps).marginTop as number;
    expect(readingBlockStyle('heading2', 'paragraph', gaps).marginTop).toBeGreaterThan(paragraphGap);
    expect(readingBlockStyle('paragraph', 'heading2', gaps).marginTop).toBeLessThan(paragraphGap);
    expect(styles.heading2).toMatchObject({ marginTop: 0, marginBottom: 0 });
  });

  it('respects reading preferences without scaling code or shrinking deep headings below body size', () => {
    const normal = createTaskMarkdownStyles(lightColors, 'normal', 'normal', 'normal', 'normal', undefined, undefined, 'v3');
    const large = createTaskMarkdownStyles(lightColors, 'large', 'airy', 'relaxed', 'relaxed', 'Noto Sans SC', 'Noto Sans SC Bold', 'v3');
    expect(large.body.fontSize).toBeGreaterThan(normal.body.fontSize);
    expect(large.body.lineHeight).toBeGreaterThan(normal.body.lineHeight);
    for (const key of ['heading4', 'heading5', 'heading6'] as const) expect(large[key].fontSize).toBeGreaterThanOrEqual(large.body.fontSize);
    expect(large.heading2.fontFamily).toBe('Noto Sans SC Bold');
    expect(large.heading1.fontSize).toBeGreaterThan(large.heading2.fontSize);
    expect(large.heading2.fontSize).toBeGreaterThan(large.heading3.fontSize);
    expect(large.fence).toEqual(normal.fence);
    expect(large.code_inline).toEqual(normal.code_inline);
  });

  it.each([lightColors, darkColors])('keeps complete Markdown semantics and bounded table layout in each theme', colors => {
    const styles = createTaskMarkdownStyles(colors, 'normal', 'normal', 'normal', 'normal', undefined, undefined, 'v3');
    const source = '# 一级\n\n第一段 **重点** 和 [说明](https://example.com)。\n\n## 二级\n\n- 保留项目\n  - 嵌套内容\n\n### 三级\n\n> 引用原文\n\n#### 四级\n\n##### 五级\n\n###### 六级\n\n| 名称 | 内容 | 归属 |\n| --- | --- | --- |\n| 项目 | 单元格原文 | server-A |\n\n```ts\nconst untouched = 1;\n```\n\n末尾完整保留';
    const html = renderToStaticMarkup(<Markdown rules={longformMarkdownRules} style={styles}>{source}</Markdown>);
    for (let level = 1; level <= 6; level++) expect(html).toContain(`aria-level="${level}"`);
    for (const text of ['重点', '嵌套内容', '引用原文', '单元格原文', 'server-A', 'const untouched = 1;', '末尾完整保留']) expect(html).toContain(text);
    expect(html).toContain('data-testid="conversation-markdown-table-viewport"');
    if (!('tr' in styles && 'thead' in styles && 'color' in styles.td)) throw new Error('V3 must supply a complete table recipe');
    expect(styles.tr.borderColor).toBe(colors.border);
    expect(styles.thead.backgroundColor).toBe(colors.surfaceHover);
    expect(styles.td.color).toBe(colors.text);
  });

  it('leaves the V1/V2 Markdown recipe unchanged', () => {
    const v2 = createTaskMarkdownStyles(lightColors);
    const v1 = createTaskMarkdownStyles(lightColors, 'normal', 'normal', 'normal', 'normal', undefined, undefined, 'classic');
    expect(v1).toEqual(v2);
    expect(v2.heading1.fontSize).toBe(32);
    expect(v2.body.gap).toBeGreaterThan(0);
  });
});
