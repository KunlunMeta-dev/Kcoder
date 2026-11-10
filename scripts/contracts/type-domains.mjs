import { CONTRACT_DOMAINS, contractDomain } from './domains.mjs';

const typeDomain = name => {
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid schema type name: ${name}`);
  return contractDomain(name.replaceAll('_', ''));
};

/** Partition declarations only. Cross-domain edges stay type-only and the
 * stable facade continues to export every original public type name. */
export function generateTypeDomains(types, dependencies, header = '') {
  const ordered = [...types].sort(([left], [right]) => left.localeCompare(right));
  const files = {};
  for (const domain of CONTRACT_DOMAINS) {
    const selected = ordered.filter(([name]) => typeDomain(name) === domain);
    const imports = new Map();
    for (const [name] of selected) for (const reference of dependencies.get(name) ?? []) {
      if (!types.has(reference)) throw new Error(`Unregistered contract type dependency: ${reference}`);
      const owner = typeDomain(reference);
      if (owner === domain) continue;
      if (!imports.has(owner)) imports.set(owner, new Set());
      imports.get(owner).add(reference);
    }
    const declarations = selected.map(([name, type]) => `export type ${name} = ${type};`).join('\n\n');
    const prelude = [...imports].sort(([left], [right]) => left.localeCompare(right)).map(([owner, names]) =>
      `import type { ${[...names].sort().join(', ')} } from './contracts.${owner}.js';`).join('\n');
    files[`contracts.${domain}.ts`] = header + (prelude ? prelude + '\n\n' : '') + declarations + '\n';
  }
  // Keep domain import paths stable while the generated storage files follow
  // their existing assistant/generation/memory/automation responsibilities.
  for (const [domain, children] of Object.entries({
    'core': ['knowledge', 'mcp', 'agents', 'task-interactions', 'workflow-collaboration', 'browser-profiles'],
    'integrations-core': ['integrations-models', 'integrations-tasks'],
    'integrations-tasks': ['integrations-task-capability-scope'],
    'integrations-office': ['integrations-office-assistants', 'integrations-office-generation'],
    'integrations-knowledge': ['integrations-knowledge-memory', 'integrations-knowledge-automation'],
    'integrations-knowledge-automation': ['integrations-knowledge-subscriptions'],
  })) files[`contracts.${domain}.ts`] += children.map(child => `export type * from './contracts.${child}.js';`).join('\n') + '\n';
  return { files, facade: CONTRACT_DOMAINS.map(domain => `export type * from './contracts.${domain}.js';`).join('\n') + '\n' };
}

export function schemaTypeReferences(schema) {
  const names = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string') names.add(value.$ref.split('/').at(-1));
    // Definitions receive their own declarations and must not create unused imports.
    for (const [key, child] of Object.entries(value)) if (key !== 'definitions') {
      if (Array.isArray(child)) child.forEach(visit); else visit(child);
    }
  };
  visit(schema);
  return names;
}
