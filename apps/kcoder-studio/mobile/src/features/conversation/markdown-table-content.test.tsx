import { describe, expect, test, vi } from 'vitest';
import { MarkdownIt, parser as parseMarkdown, type ASTNode } from 'react-native-markdown-display';
import { tableToMarkdown } from './markdown-table-content';

vi.mock('react-native-fit-image', () => ({ default: () => null }));
const parser = new MarkdownIt({ html: false });
const parse = (source: string) => {
  let nodes: ASTNode[] = [];
  parseMarkdown(source, tree => { nodes = tree as unknown as ASTNode[]; return null as never; }, parser);
  return nodes;
};
const tables = (nodes: ASTNode[]): ASTNode[] => nodes.flatMap(node => node.type === 'table' ? [node] : tables(node.children));

describe('copying an individual Markdown table', () => {
  test('copies only the selected table and preserves alignment and inline formatting', () => {
    const source = '# Private surrounding text\n\n| Left | Center | Right |\n| :--- | :---: | ---: |\n| **Bold** *emphasis* ~~removed~~ | [Docs](https://example.test/docs "Read") | `x` |\n\nAnother paragraph.\n\n| Other |\n| --- |\n| Excluded |';
    const [first, second] = tables(parse(source));
    const copied = tableToMarkdown(first);
    expect(copied).toBe('| Left | Center | Right |\n| :--- | :---: | ---: |\n| **Bold** *emphasis* ~~removed~~ | [Docs](https://example.test/docs "Read") | `x` |');
    expect(tableToMarkdown(second)).toContain('Excluded');
    expect(copied).not.toMatch(/Private|Another|Excluded/);
  });

  test('escaped pipes, literal formatting characters, and backtick code survive reparsing', () => {
    const source = '| Content | Code |\n| --- | --- |\n| a\\|b \\*literal\\* C:\\\\tmp | `` a`b\\|c `` |';
    const original = tables(parse(source))[0];
    const copied = tableToMarkdown(original);
    const simplify = (node: ASTNode): unknown => ({ type: node.type, content: node.children.length ? '' : node.content, attributes: node.attributes, children: node.children.map(simplify) });
    expect(simplify(tables(parse(copied))[0])).toEqual(simplify(original));
  });

  test('never copies a whole reply when given a non-table node', () => {
    expect(tableToMarkdown(parse('Unrelated text')[0])).toBe('');
  });

  test('keeps links containing inline code, images, and literal punctuation', () => {
    const source = '| Details |\n| --- |\n| [**Docs** `v2`](https://example.test/docs) ![Chart](https://example.test/chart.png) \\![plain](https://example.test) \\~\\~literal\\~\\~ |';
    const copied = tableToMarkdown(tables(parse(source))[0]);
    expect(copied).toContain('[**Docs** `v2`](https://example.test/docs)');
    expect(copied).toContain('![Chart](https://example.test/chart.png)');
    expect(copied).toContain('\\![plain](https://example.test)');
    expect(copied).toContain('\\~\\~literal\\~\\~');
  });
});
