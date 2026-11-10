import { renderRules, type ASTNode, type RenderFunction, type RenderRules } from 'react-native-markdown-display';

function nodeKey(node: ASTNode, parents: ASTNode[]): string {
  return [...parents].reverse().concat(node).map(part => `${part.type}:${part.index ?? 0}`).join('/');
}

/** Parser-generated IDs change on every delta. Structural keys keep mounted disclosure state local to one Markdown tree. */
export function stableMarkdownRules(overrides: RenderRules): RenderRules {
  return Object.fromEntries(Object.entries({ ...renderRules, ...overrides }).filter(([, rule]) => rule).map(([type, rule]) => {
    const render = rule as RenderFunction;
    const stable: RenderFunction = (node, children, parents, styles, ...rest) => {
      const key = nodeKey(node, parents);
      return render({ ...node, key, children: node.children.map(child => ({ ...child, key: `${key}/${child.type}:${child.index ?? 0}` })) }, children, parents, styles, ...rest);
    };
    return [type, stable];
  }));
}
