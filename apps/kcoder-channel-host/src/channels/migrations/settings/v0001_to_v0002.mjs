import { applyEdits, createScanner, findNodeAtLocation, parseTree, SyntaxKind } from 'jsonc-parser';

/** Normalize only known v1 Gateway settings; unknown fields retain their original meaning. */
export function migrateSettingsV1(document) {
  if (Object.hasOwn(document, 'config_version') && document.config_version !== 1) {
    throw Object.assign(new Error('CHANNEL_SETTINGS_VERSION_UNSUPPORTED'), { code: 'CONFIG_VERSION_UNSUPPORTED' });
  }
  const legacy = document.mirror_client_turns, nested = document.channels?.mirror_client_turns;
  if (legacy !== undefined && typeof legacy !== 'boolean') throw new Error('CHANNEL_SETTINGS_INVALID');
  if (legacy !== undefined && nested !== undefined && legacy !== nested) {
    throw new Error('CHANNEL_SETTINGS_MIGRATION_CONFLICT');
  }
  const migrated = { ...document, meta: { ...document.meta, config_version: 2 },
    channels: { ...document.channels, mirror_client_turns: nested ?? legacy ?? false } };
  delete migrated.config_version;
  delete migrated.mirror_client_turns;
  return migrated;
}

/** Remove only the old key/value and its comma; JSONC's whole-line removal can erase adjacent comments. */
export function removeV1Keys(raw) {
  for (const name of ['config_version', 'mirror_client_turns']) {
    const root = parseTree(raw), property = findNodeAtLocation(root, [name])?.parent;
    if (!property) continue;
    if (root.children.filter(node => node.children[0].value === name).length !== 1) {
      throw new Error('CHANNEL_SETTINGS_MIGRATION_CONFLICT');
    }
    const scanner = createScanner(raw, true), edits = [{ offset: property.offset, length: property.length, content: '' }];
    scanner.setPosition(property.offset + property.length);
    if (scanner.scan() === SyntaxKind.CommaToken) edits.push({ offset: scanner.getTokenOffset(), length: 1, content: '' });
    else {
      const previous = root.children[root.children.indexOf(property) - 1];
      if (previous) {
        scanner.setPosition(previous.offset + previous.length);
        if (scanner.scan() !== SyntaxKind.CommaToken) throw new Error('CHANNEL_SETTINGS_INVALID');
        edits.push({ offset: scanner.getTokenOffset(), length: 1, content: '' });
      }
    }
    raw = applyEdits(raw, edits);
  }
  return raw;
}
