import type { ASTNode } from 'react-native-markdown-display';

function rows(node: ASTNode): ASTNode[] {
  return node.type === 'tr' ? [node] : node.children.flatMap(rows);
}

function inline(node: ASTNode): string {
  const content = () => node.children.map(inline).join('');
  switch (node.type) {
    case 'text': return node.content.replace(/([\\`*_[\]<>|!~])/g, '\\$1');
    case 'softbreak': return ' ';
    case 'hardbreak': return '<br>';
    case 'code_inline': {
      const fence = '`'.repeat(Math.max(0, ...(node.content.match(/`+/g) ?? []).map(run => run.length)) + 1);
      const padding = /^[` ]|[` ]$/.test(node.content) && !/^ +$/.test(node.content) ? ' ' : '';
      const code = node.content.replace(/\\*\|/g, value => value.startsWith('\\') ? value : '\\|');
      return `${fence}${padding}${code}${padding}${fence}`;
    }
    case 'strong': return `**${content()}**`;
    case 'em': return `*${content()}*`;
    case 's': return `~~${content()}~~`;
    case 'link':
    case 'blocklink':
    case 'image': {
      const destination = String(node.attributes[node.type === 'image' ? 'src' : 'href'] ?? '')
        .replace(/[\s()<>\\|]/g, character => encodeURIComponent(character).replace(/[()]/g, value => `%${value.charCodeAt(0).toString(16)}`));
      const title = node.attributes.title ? ` "${String(node.attributes.title).replace(/([\\"|])/g, '\\$1')}"` : '';
      return `${node.type === 'image' ? '!' : ''}[${content() || (node.type === 'image' ? node.content : '')}](${destination}${title})`;
    }
    default: return node.children.length ? content() : node.content ?? '';
  }
}

export function tableColumnCount(node: ASTNode): number {
  return Math.max(1, ...rows(node).map(row => row.children.length));
}

/** Serialize only this table, preserving inline formatting and column alignment. */
export function tableToMarkdown(node: ASTNode): string {
  if (node.type !== 'table') return '';
  const tableRows = rows(node);
  if (!tableRows.length) return '';
  const count = tableColumnCount(node);
  const line = (row: ASTNode) => `| ${Array.from({ length: count }, (_, index) =>
    row.children[index] ? inline(row.children[index]).replace(/\r?\n/g, '<br>') : '',
  ).join(' | ')} |`;
  const separator = Array.from({ length: count }, (_, index) => {
    const attributes = tableRows[0].children[index]?.attributes ?? {};
    const alignment = attributes.align ?? /text-align\s*:\s*(left|right|center)/.exec(attributes.style ?? '')?.[1];
    return alignment === 'center' ? ':---:' : alignment === 'right' ? '---:' : alignment === 'left' ? ':---' : '---';
  });
  return [line(tableRows[0]), `| ${separator.join(' | ')} |`, ...tableRows.slice(1).map(line)].join('\n');
}
