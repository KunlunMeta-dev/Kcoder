import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CADDYFILE_PATH = '/etc/caddy/Caddyfile';
export const RELAY_FRAGMENT_PATH = '/etc/caddy/kcoder-relay.caddy';

const IMPORT_BEGIN = '# KCODER-RELAY-IMPORT-BEGIN v1';
const IMPORT_END = '# KCODER-RELAY-IMPORT-END v1';
const GLOBAL_BEGIN = '# KCODER-RELAY-GLOBAL-BEGIN v1';
const GLOBAL_END = '# KCODER-RELAY-GLOBAL-END v1';
const ON_DEMAND_BEGIN = '# KCODER-RELAY-ON-DEMAND-BEGIN v1';
const ON_DEMAND_END = '# KCODER-RELAY-ON-DEMAND-END v1';

function canonicalDomain(value) {
  if (typeof value !== 'string' || value.length > 253 || value.includes(':') || value.includes('/')) {
    throw new Error('Invalid Caddy Relay domain');
  }
  const domain = value.toLowerCase();
  if (domain.split('.').length < 2 || domain.split('.').some((label) => (
    !label || label.length > 63 || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label)
  ))) throw new Error('Invalid Caddy Relay domain');
  return domain;
}

function validPort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid Caddy ${name}`);
  return port;
}

export function parseRelayCaddySettings(contents) {
  if (typeof contents !== 'string') throw new Error('Caddy environment must be text');
  const values = new Map();
  for (const line of contents.split(/\r?\n/)) {
    if (!line) continue;
    const match = line.match(/^(KCODER_RELAY_(?:DOMAIN|PUBLIC_PORT|CONTROL_PORT|PROXY_PORT))=([A-Za-z0-9.-]+)$/);
    if (!match || values.has(match[1])) throw new Error('Invalid or duplicate Caddy deployment setting');
    values.set(match[1], match[2]);
  }
  const required = ['KCODER_RELAY_DOMAIN', 'KCODER_RELAY_PUBLIC_PORT', 'KCODER_RELAY_CONTROL_PORT', 'KCODER_RELAY_PROXY_PORT'];
  if (required.some((key) => !values.has(key))) throw new Error('Caddy deployment settings are incomplete');
  return {
    domain: canonicalDomain(values.get('KCODER_RELAY_DOMAIN')),
    publicPort: validPort(values.get('KCODER_RELAY_PUBLIC_PORT'), 'public port'),
    controlPort: validPort(values.get('KCODER_RELAY_CONTROL_PORT'), 'control port'),
    proxyPort: validPort(values.get('KCODER_RELAY_PROXY_PORT'), 'proxy port'),
  };
}

/** Loopback-only Caddy `ask` URL served by the Relay control listener. */
export function relayTlsAskUrl(controlPort) {
  return `http://127.0.0.1:${validPort(controlPort, 'control port')}/_relay/tls-ask`;
}

export function buildRelayCaddySnippet(settings, template = readFileSync(fileURLToPath(new URL('./Caddyfile', import.meta.url)), 'utf8')) {
  const { domain, publicPort, controlPort, proxyPort } = settings;
  const authority = publicPort === 443 ? domain : `${domain}:${publicPort}`;
  const replacements = new Map([
    ['https://*.{$KCODER_RELAY_DOMAIN}:{$KCODER_RELAY_PUBLIC_PORT}', `https://*.${authority}`],
    ['https://{$KCODER_RELAY_DOMAIN}:{$KCODER_RELAY_PUBLIC_PORT}', `https://${authority}`],
    ['{$KCODER_RELAY_CONTROL_PORT}', String(controlPort)],
    ['{$KCODER_RELAY_PROXY_PORT}', String(proxyPort)],
  ]);
  let result = template;
  for (const [source, replacement] of replacements) result = result.replaceAll(source, replacement);
  if (result.includes('{$KCODER_RELAY_')) throw new Error('Caddy template contains unresolved Relay settings');
  return result.endsWith('\n') ? result : `${result}\n`;
}

function lineWithoutComment(line) {
  let quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === '`') quote = char;
    else if (char === '#') return line.slice(0, index);
  }
  return line;
}

function bracesOnLine(line) {
  const clean = lineWithoutComment(line);
  let quote = '';
  let opens = 0;
  let closes = 0;
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === '`') quote = char;
    else if (char === '{') opens += 1;
    else if (char === '}') closes += 1;
  }
  return { opens, closes, clean };
}

export function parseTopLevelCaddyBlocks(contents) {
  if (typeof contents !== 'string') throw new Error('Caddyfile must be text');
  const lines = contents.split(/(?<=\n)/);
  const blocks = [];
  let depth = 0;
  let start = -1;
  let header = '';
  for (let index = 0; index < lines.length; index += 1) {
    const { opens, closes, clean } = bracesOnLine(lines[index]);
    if (depth === 0 && opens > 0 && opens === closes) {
      blocks.push({ start: index, end: index + 1, header: clean.slice(0, clean.indexOf('{')).trim(), text: lines[index] });
      continue;
    }
    if (depth === 0 && opens > closes) {
      start = index;
      header = clean.slice(0, clean.indexOf('{')).trim();
    } else if (depth === 0 && opens === 0 && clean.trim() && !clean.trim().startsWith('#')) {
      // Directives without blocks do not change the nesting state.
    }
    depth += opens - closes;
    if (depth < 0) throw new Error('Caddyfile has an unmatched closing brace');
    if (depth === 0 && start >= 0) {
      blocks.push({ start, end: index + 1, header, text: lines.slice(start, index + 1).join('') });
      start = -1;
      header = '';
    }
  }
  if (depth !== 0 || start >= 0) throw new Error('Caddyfile has an unclosed block');
  return blocks;
}

function removeManagedImport(contents) {
  const lines = contents.split(/(?<=\n)/);
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== IMPORT_BEGIN) continue;
    if (lines[index + 1]?.trim() !== `import ${RELAY_FRAGMENT_PATH}` || lines[index + 2]?.trim() !== IMPORT_END) {
      throw new Error('Managed Caddy import block was modified');
    }
    matches.push([index, index + 3]);
  }
  if (matches.length > 1) throw new Error('Duplicate managed Caddy import blocks');
  if (!matches.length) return { contents, found: false };
  const [start, end] = matches[0];
  return { contents: [...lines.slice(0, start), ...lines.slice(end)].join(''), found: true };
}

const ASK_PATTERN = 'ask http://127\\.0\\.0\\.1:\\d{1,5}/_relay/tls-ask';
// Deployments before isolated Gateway origins owned a global block without an ask.
const MANAGED_GLOBAL_BODIES = [
  /^\{\n {4}auto_https disable_redirects\n\}$/,
  new RegExp(`^\\{\\n {4}auto_https disable_redirects\\n {4}on_demand_tls \\{\\n {8}${ASK_PATTERN}\\n {4}\\}\\n\\}$`),
];
const MANAGED_ON_DEMAND = new RegExp(`^ {4}${ON_DEMAND_BEGIN}\\n {4}on_demand_tls \\{\\n {8}${ASK_PATTERN}\\n {4}\\}\\n(?: {4}tls_automate_names [a-z0-9.-]+(?: [a-z0-9.-]+)*\\n)? {4}${ON_DEMAND_END}\\n$`);

function managedGlobalBlock(askUrl) {
  return `${GLOBAL_BEGIN}\n{\n    auto_https disable_redirects\n    on_demand_tls {\n        ask ${askUrl}\n    }\n}\n${GLOBAL_END}\n`;
}

function removeManagedGlobal(contents) {
  const lines = contents.split(/(?<=\n)/);
  const begin = lines.findIndex((line) => line.trim() === GLOBAL_BEGIN);
  const end = lines.findIndex((line) => line.trim() === GLOBAL_END);
  if (begin < 0 && end < 0) return { contents, found: false };
  if (begin < 0 || end < begin) throw new Error('Managed Caddy global option block was modified');
  const body = lines.slice(begin + 1, end).join('').trim();
  if (!MANAGED_GLOBAL_BODIES.some((pattern) => pattern.test(body))) {
    throw new Error('Managed Caddy global option block was modified');
  }
  return { contents: [...lines.slice(0, begin), ...lines.slice(end + 1)].join(''), found: true };
}

/** Remove the marked on_demand_tls lines this tool inserted into a user-owned global block. */
function removeManagedOnDemand(contents) {
  const lines = contents.split(/(?<=\n)/);
  const begins = lines.flatMap((line, index) => (line.trim() === ON_DEMAND_BEGIN ? [index] : []));
  const ends = lines.flatMap((line, index) => (line.trim() === ON_DEMAND_END ? [index] : []));
  if (!begins.length && !ends.length) return { contents, found: false };
  if (begins.length !== 1 || ends.length !== 1 || ![4, 5].includes(ends[0] - begins[0])
      || !MANAGED_ON_DEMAND.test(lines.slice(begins[0], ends[0] + 1).join(''))) {
    throw new Error('Managed Caddy on-demand TLS block was modified');
  }
  const removed = [...lines.slice(0, begins[0]), ...lines.slice(ends[0] + 1)].join('');
  const global = parseTopLevelCaddyBlocks(removed).find((block) => block.header === '');
  if (!global || global.start >= begins[0] || global.end <= begins[0]) {
    throw new Error('Managed Caddy on-demand TLS block is outside the global options');
  }
  return { contents: removed, found: true };
}

/**
 * on_demand_tls is one global policy. Any other on-demand site or ask/permission
 * would be silently re-scoped by the Relay's ask, so merging fails closed.
 */
function assertNoForeignOnDemand(contents) {
  for (const line of contents.split(/\r?\n/)) {
    if (/(?:^|\s)on_demand(?:_tls)?(?:\s|\{|$)/.test(lineWithoutComment(line))) {
      throw new Error('Shared Caddy already configures on-demand TLS; refusing to merge or replace its ask/permission policy for Relay Gateway origins');
    }
  }
}

function insertManagedOnDemand(contents, global, askUrl, preserveCertificateNames = []) {
  const lines = contents.split(/(?<=\n)/);
  if (lineWithoutComment(lines[global.start]).trim() !== '{') {
    throw new Error('Shared Caddy global options must open with "{" on its own line; refusing to merge on-demand TLS');
  }
  const explicitNames = preserveCertificateNames.length ? `    tls_automate_names ${preserveCertificateNames.join(' ')}\n` : '';
  const managed = `    ${ON_DEMAND_BEGIN}\n    on_demand_tls {\n        ask ${askUrl}\n    }\n${explicitNames}    ${ON_DEMAND_END}\n`;
  return [...lines.slice(0, global.start + 1), managed, ...lines.slice(global.start + 1)].join('');
}

function gatewaySiteHeaderMatches(header, domain, publicPort) {
  const authority = publicPort === 443 ? domain : `${domain}:${publicPort}`;
  return header.replace(/^https:\/\//i, '').trim().toLowerCase() === `*.${authority}`;
}

function headerNamesGatewayOrigins(header, domain) {
  return header.split(/[\s,]+/).some((address) => (
    address.replace(/^https?:\/\//i, '').replace(/:\d+$/, '').toLowerCase() === `*.${domain}`
  ));
}

function relaySiteHeaderMatches(header, domain, publicPort) {
  const site = header.replace(/^https:\/\//i, '').trim();
  const authority = publicPort === 443 ? domain : `${domain}:${publicPort}`;
  return site.toLowerCase() === authority;
}

function extractBalancedBlock(text, openIndex) {
  let depth = 0;
  let quote = '';
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === '`') quote = char;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex, index + 1);
    }
  }
  throw new Error('Caddy site block is incomplete');
}

function nestedDirectives(siteBlock, name) {
  const output = [];
  const lines = siteBlock.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lineWithoutComment(lines[index]);
    const match = line.match(/^\s*handle(?:\s+(\S+))?\s*\{/);
    if (!match) continue;
    let depth = 0;
    const collected = [];
    for (; index < lines.length; index += 1) {
      const current = lineWithoutComment(lines[index]);
      collected.push(current);
      const counts = bracesOnLine(current);
      depth += counts.opens - counts.closes;
      if (depth === 0) break;
    }
    if (match[1] === name || (name === '' && match[1] === undefined)) output.push(collected.join('\n'));
  }
  return output;
}

export function validateAdoptableRelaySite(siteBlock, settings) {
  const { domain, publicPort, controlPort, proxyPort } = settings;
  const opening = siteBlock.match(/^\s*([^\n{]+)\s*\{/);
  if (!opening || !relaySiteHeaderMatches(opening[1].trim(), domain, publicPort)) {
    throw new Error('Existing Caddy site does not match the canonical Relay host');
  }
  const compact = siteBlock.split(/\r?\n/).map(lineWithoutComment).join('').replace(/\s+/g, '').toLowerCase();
  const canonicalAuthority = publicPort === 443 ? domain : `${domain}:${publicPort}`;
  const headers = [canonicalAuthority, `https://${canonicalAuthority}`];
  const control = nestedDirectives(siteBlock, '/_relay/*');
  const gateway = nestedDirectives(siteBlock, '/g/*');
  const fallback = nestedDirectives(siteBlock, '');
  if (control.length !== 1 || gateway.length !== 1 || fallback.length !== 1) {
    throw new Error('Existing Relay site must contain the two Relay routes and one supported fallback');
  }
  const proxyHandleForms = (path, port) => {
    const base = `handle${path}{reverse_proxy127.0.0.1:${port}`;
    return [
      `${base}}`,
      `${base}{header_uphost{http.request.hostport}}}`,
      `${base}{flush_interval-1}}`,
      `${base}{header_uphost{http.request.hostport}flush_interval-1}}`,
    ];
  };
  const hardenedControl = 'handle/_relay/*{route{@relayadminpath/_relay/admin/_relay/admin/*respond@relayadmin404' +
    `reverse_proxy127.0.0.1:${controlPort}{header_uphost{http.request.hostport}}}}`;
  const controlForms = [...proxyHandleForms('/_relay/*', controlPort), hardenedControl];
  const gatewayForms = proxyHandleForms('/g/*', proxyPort);
  const fallbackForms = [
    'handle{respond404}',
    ...proxyHandleForms('', proxyPort),
  ];
  if (!controlForms.includes(control[0].replace(/\s+/g, '').toLowerCase())
      || !gatewayForms.includes(gateway[0].replace(/\s+/g, '').toLowerCase())
      || !fallbackForms.includes(fallback[0].replace(/\s+/g, '').toLowerCase())) {
    throw new Error('Existing Relay site contains an unsupported directive or fallback route');
  }
  const expectedSites = headers.flatMap((header) => controlForms.flatMap((controlForm) => gatewayForms.flatMap((gatewayForm) => fallbackForms.map((fallbackForm) => (
    `${header}{tls{issueracme{disable_http_challenge}}${controlForm}${gatewayForm}${fallbackForm}}`
  )))));
  if (!expectedSites.includes(compact)) throw new Error('Existing Relay site has an unsupported TLS or route directive');
  return siteBlock.endsWith('\n') ? siteBlock : `${siteBlock}\n`;
}

/**
 * An unreceipted managed fragment holds the adoptable root site and, when it
 * came from an isolated-origin release, exactly the expected Gateway site.
 */
function adoptableFragment(existingFragment, settings, gatewaySiteText) {
  const compact = (text) => text.split(/\r?\n/).map(lineWithoutComment).join('').replace(/\s+/g, '').toLowerCase();
  const blocks = parseTopLevelCaddyBlocks(existingFragment);
  const roots = blocks.filter((block) => relaySiteHeaderMatches(block.header, settings.domain, settings.publicPort));
  const others = blocks.filter((block) => !roots.includes(block));
  if (roots.length !== 1 || others.length > 1 || (others.length === 1 && compact(others[0].text) !== compact(gatewaySiteText))) {
    throw new Error('Existing Relay fragment contains an unsupported site');
  }
  return `${validateAdoptableRelaySite(roots[0].text, settings)}\n${gatewaySiteText}`;
}

/**
 * Validate adapted JSON: the single global on-demand permission must be the
 * Relay's loopback ask, and no other site may rely on that policy.
 */
export function validateRelayOnDemandTls(adaptedConfig, settings) {
  const askUrl = relayTlsAskUrl(settings.controlPort);
  const automation = adaptedConfig?.apps?.tls?.automation;
  const onDemand = automation?.on_demand;
  const endpoint = onDemand?.ask ?? (onDemand?.permission?.module === 'http' ? onDemand.permission.endpoint : undefined);
  if (endpoint !== askUrl) throw new Error('Caddy adaptation does not use the Relay on-demand TLS ask endpoint');
  const wildcard = `*.${canonicalDomain(settings.domain)}`;
  for (const policy of automation.policies || []) {
    if (policy?.on_demand !== true) continue;
    const subjects = Array.isArray(policy.subjects) ? policy.subjects : [];
    if (!subjects.length || subjects.some((subject) => subject !== wildcard)) {
      throw new Error('Another Caddy site uses on-demand TLS; refusing to share the Relay ask policy');
    }
  }
}

export function createCaddyInstallPlan({
  mainContents,
  mainFileExists = true,
  existingFragment,
  fragmentHashOwned = false,
  globalOwned = false,
  settings,
  fragmentContents,
  adoptExisting = false,
}) {
  const domain = canonicalDomain(settings.domain);
  const publicPort = validPort(settings.publicPort, 'public port');
  const askUrl = relayTlsAskUrl(settings.controlPort);
  const gatewaySite = parseTopLevelCaddyBlocks(fragmentContents || '')
    .filter((block) => gatewaySiteHeaderMatches(block.header, domain, publicPort));
  if (gatewaySite.length !== 1) throw new Error('Relay Caddy fragment must contain exactly one Gateway origin site');
  const gatewaySiteText = gatewaySite[0].text.endsWith('\n') ? gatewaySite[0].text : `${gatewaySite[0].text}\n`;
  const baseContents = mainContents || '';
  const importResult = removeManagedImport(baseContents);
  const globalResult = removeManagedGlobal(importResult.contents);
  const onDemandResult = removeManagedOnDemand(globalResult.contents);
  let base = onDemandResult.contents;
  assertNoForeignOnDemand(base);
  let createdGlobal = false;

  if (globalOwned && globalResult.found && base.trim()) {
    base = `${managedGlobalBlock(askUrl)}${base}`;
    createdGlobal = true;
  } else if (mainFileExists && base.trim()) {
    const topBlocks = parseTopLevelCaddyBlocks(base);
    const global = topBlocks.find((block) => block.header === '');
    const globalDirectives = global?.text.split(/\r?\n/).map(lineWithoutComment).join('\n') || '';
    if (!/\bauto_https\s+[^\n]*\bdisable_redirects\b/.test(globalDirectives)) {
      throw new Error('Shared Caddy must already disable automatic HTTP redirects; refusing to alter shared global options');
    }
    // Only marked lines are added inside the user's global block; cleanup removes exactly them.
    base = insertManagedOnDemand(base, global, askUrl);
  } else {
    base = `${managedGlobalBlock(askUrl)}${base}`;
    createdGlobal = true;
  }

  const blocks = parseTopLevelCaddyBlocks(base);
  if (blocks.some((block) => block.header && headerNamesGatewayOrigins(block.header, domain))) {
    throw new Error('Another Caddy site already serves the Relay Gateway origin wildcard; refusing to replace it');
  }
  const matching = blocks.filter((block) => relaySiteHeaderMatches(block.header, domain, publicPort));
  let fragment = fragmentContents;
  if (matching.length > 1) throw new Error('Multiple Caddy sites match the configured Relay host');
  if (matching.length === 1) {
    if (!adoptExisting && !importResult.found) throw new Error('A Caddy site already owns the Relay host; pass --adopt-existing after verifying it');
    const existingSite = validateAdoptableRelaySite(matching[0].text, settings);
    const lines = base.split(/(?<=\n)/);
    base = [...lines.slice(0, matching[0].start), ...lines.slice(matching[0].end)].join('');
    if (!importResult.found || !fragmentHashOwned) fragment = `${existingSite}\n${gatewaySiteText}`;
  } else if (importResult.found && !fragmentHashOwned && !adoptExisting) {
    throw new Error('An unreceipted managed Caddy fragment requires explicit adoption');
  } else if (importResult.found && !fragmentHashOwned && adoptExisting) {
    fragment = adoptableFragment(existingFragment || '', settings, gatewaySiteText);
  }

  if (!fragment || !fragment.trim()) throw new Error('Relay Caddy fragment is empty');
  const finalMain = `${base.trimEnd()}\n${IMPORT_BEGIN}\nimport ${RELAY_FRAGMENT_PATH}\n${IMPORT_END}\n`;
  return { mainContents: finalMain, fragmentContents: fragment, createdGlobal, adoptedSite: matching.length === 1 };
}

/** Add registered origins without adopting or replacing an existing custom root site. */
export function createGatewayOriginExpansionPlan({ mainContents, fragmentContents, settings, preserveCertificateNames = [] }) {
  const { domain, publicPort, controlPort, proxyPort } = settings;
  const askUrl = relayTlsAskUrl(controlPort);
  const generated = buildRelayCaddySnippet(settings);
  const wildcard = parseTopLevelCaddyBlocks(generated).find(block => gatewaySiteHeaderMatches(block.header, domain, publicPort));
  const blocks = parseTopLevelCaddyBlocks(fragmentContents);
  const root = blocks.filter(block => relaySiteHeaderMatches(block.header, domain, publicPort));
  if (root.length !== 1 || !nestedDirectives(root[0].text, '/_relay/*').some(route => route.includes(`reverse_proxy 127.0.0.1:${controlPort}`)) ||
      !nestedDirectives(root[0].text, '/g/*').some(route => route.includes(`reverse_proxy 127.0.0.1:${proxyPort}`)))
    throw new Error('Existing Relay root routes do not match the selected instance');
  const existing = blocks.filter(block => gatewaySiteHeaderMatches(block.header, domain, publicPort));
  if (existing.length > 1 || (existing.length && existing[0].text.trim() !== wildcard.text.trim()))
    throw new Error('Existing Gateway wildcard policy differs from the selected Relay policy');
  const fragmentWithoutWildcard = existing.length ? fragmentContents.replace(existing[0].text, '') : fragmentContents;
  assertNoForeignOnDemand(fragmentWithoutWildcard);
  const base = removeManagedOnDemand(mainContents).contents;
  assertNoForeignOnDemand(base);
  const global = parseTopLevelCaddyBlocks(base).find(block => block.header === '');
  if (!global || !/\bauto_https\s+[^\n]*\bdisable_redirects\b/.test(global.text))
    throw new Error('Existing Caddy global options do not permit a scoped Relay expansion');
  const imports = base.split(/\r?\n/).filter(line => line.trim() === `import ${RELAY_FRAGMENT_PATH}`);
  if (imports.length !== 1) throw new Error('Existing Relay fragment must have exactly one persistent import');
  const configuredNames = new Set([...parseTopLevelCaddyBlocks(base), ...blocks].flatMap(block =>
    block.header.split(/[\s,]+/).flatMap(address => {
      try { return [new URL(address.includes('://') ? address : `https://${address}`).hostname]; }
      catch { return []; }
    })));
  if (!Array.isArray(preserveCertificateNames) || preserveCertificateNames.length > 256 ||
      new Set(preserveCertificateNames).size !== preserveCertificateNames.length ||
      preserveCertificateNames.some(name => canonicalDomain(name) !== name || !configuredNames.has(name) ||
        (name !== domain && !name.endsWith(`.${domain}`))))
    throw new Error('Explicit certificate preservation requires existing exact Relay site names');
  // Caddy 2.11 otherwise skips exact names covered by the new on-demand wildcard.
  // Explicit management keeps their existing certificates loaded without widening ask.
  return { mainContents: insertManagedOnDemand(base, global, askUrl, preserveCertificateNames),
    fragmentContents: existing.length ? fragmentContents : `${fragmentContents.trimEnd()}\n\n${wildcard.text.trim()}\n` };
}

export function createCaddyCleanupPlan({
  mainContents,
  expectedFragmentHash,
  expectedFragmentHashes,
  actualFragmentHash,
  mainFileCreatedByKcoder = false,
}) {
  const acceptedHashes = expectedFragmentHashes || [expectedFragmentHash];
  if (!acceptedHashes.includes(actualFragmentHash)) throw new Error('Managed Caddy fragment drifted; refusing cleanup');
  const imported = removeManagedImport(mainContents);
  if (!imported.found) throw new Error('Managed Caddy import is missing; refusing cleanup');
  const global = removeManagedGlobal(imported.contents);
  const onDemand = removeManagedOnDemand(global.contents);
  let cleanedMain = onDemand.contents.trim() ? onDemand.contents : '';
  let globalRelinquished = false;
  if (global.found && parseTopLevelCaddyBlocks(cleanedMain).some((block) => block.header !== '')) {
    cleanedMain = `{\n    auto_https disable_redirects\n}\n${cleanedMain}`;
    globalRelinquished = true;
  }
  return {
    mainContents: cleanedMain,
    removeMainFile: mainFileCreatedByKcoder && cleanedMain === '',
    removeFragment: true,
    globalRelinquished,
  };
}

export function hasPort80Listener(adaptedConfig) {
  const servers = adaptedConfig?.apps?.http?.servers;
  if (servers === undefined) return false;
  if (!servers || typeof servers !== 'object') throw new Error('Caddy adaptation has an invalid HTTP server map');
  for (const server of Object.values(servers)) {
    for (const listener of server.listen || []) {
      const value = String(listener).trim();
      if (/(?:^|:|\])80$/.test(value)) return true;
    }
  }
  return false;
}

export function port80ListenerState(adaptedConfig) {
  const servers = adaptedConfig?.apps?.http?.servers;
  if (servers === undefined) return [];
  if (!servers || typeof servers !== 'object') throw new Error('Caddy adaptation has an invalid HTTP server map');
  const state = [];
  for (const [name, server] of Object.entries(servers)) {
    const listeners = (server?.listen || []).map((listener) => String(listener).trim());
    if (listeners.some((listener) => /(?:^|:|\])80$/.test(listener))) {
      state.push([name, JSON.stringify(server)]);
    }
  }
  return state.sort(([left], [right]) => left.localeCompare(right));
}

export function assertPort80ListenerStateUnchanged(baselineConfig, candidateConfig) {
  if (JSON.stringify(port80ListenerState(baselineConfig)) !== JSON.stringify(port80ListenerState(candidateConfig))) {
    throw new Error('Relay deployment would add or change a Caddy port-80 listener');
  }
}
